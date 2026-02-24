'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { PolygonLayer } from '@deck.gl/layers';
import type { MapViewState as MapViewStateType } from '@deck.gl/core';
import Papa from 'papaparse';
import 'maplibre-gl/dist/maplibre-gl.css';
import { calculateGeodesicDistance } from '@/lib/geodesic';

// DeckGLとMapをクライアントサイドでのみロード
const DeckGL = dynamic(() => import('@deck.gl/react').then((mod) => mod.default), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full">マップを読み込み中...</div>,
});

const Map = dynamic(() => import('react-map-gl/maplibre').then((mod) => mod.Map), {
  ssr: false,
});

interface BusDataRow {
  vehicle_key: string;
  full_date: string;
  trip_key: string;
  route_key: string;
  utc_time: string;
  vehicle_id: string;
  mode: string;
  lat: string;
  lon: string;
}

interface FileData {
  fileName: string;
  data: BusDataRow[];
  color: [number, number, number];
  offset: number; // ファイル固有のオフセット高さ
}

interface Segment {
  startIndex: number;
  endIndex: number;
  distance: number;
  autoRatio: number;
  centerLat: number;
  centerLon: number;
  startTime: Date;
  endTime: Date;
  fileIndex: number;
}

interface SpaceTimeCube {
  lat: number;
  lon: number;
  time: Date;
  autoRatio: number;
  count: number;
  fileIndex: number;
}

interface ColumnData {
  position: [number, number];
  elevation: number;
  color: [number, number, number];
  autoRatio: number;
  fileIndex: number;
  time: Date;
  bottomHeight: number; // ボックスの底面の高さ
}

const FILE_COLORS: [number, number, number][] = [
  [239, 68, 68], // red
  [59, 130, 246], // blue
  [34, 197, 94], // green
  [245, 158, 11], // amber
  [139, 92, 246], // violet
  [236, 72, 153], // pink
];

export default function Map3DPage() {
  const availableFiles = ['demo.csv', 'demo2.csv', 'demo3.csv'];
  const [isMounted, setIsMounted] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [filesData, setFilesData] = useState<FileData[]>([]);
  const [spatialGridSize, setSpatialGridSize] = useState<number>(0.001); // 度（約100m）
  const [layerSpacing, setLayerSpacing] = useState<number>(300); // ファイル間の垂直距離
  const [baseOffset, setBaseOffset] = useState<number>(0); // 基準オフセット高さ
  const [boxHeight, setBoxHeight] = useState<number>(100);
  const [viewState, setViewState] = useState<MapViewStateType>({
    longitude: 140.5307,
    latitude: 36.5388,
    zoom: 14,
    pitch: 60,
    bearing: 0,
  });

  // ファイルのオフセット更新
  const updateFileOffset = useCallback((fileName: string, offset: number) => {
    setFilesData((prev) =>
      prev.map((file) =>
        file.fileName === fileName ? { ...file, offset } : file
      )
    );
  }, []);

  // クライアントサイドでのみレンダリング
  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleFileToggle = useCallback(
    async (fileName: string) => {
      const newSelected = new Set(selectedFiles);

      if (newSelected.has(fileName)) {
        // ファイルの選択解除
        newSelected.delete(fileName);
        setSelectedFiles(newSelected);
        setFilesData((prev) => prev.filter((f) => f.fileName !== fileName));
      } else {
        // ファイルの選択追加
        newSelected.add(fileName);
        setSelectedFiles(newSelected);

        try {
          const response = await fetch(`/data/${fileName}`);
          const csvText = await response.text();

          Papa.parse<BusDataRow>(csvText, {
            header: true,
            complete: (results) => {
              const sortedData = results.data
                .filter((row) => row.lat && row.lon)
                .sort(
                  (a, b) =>
                    new Date(a.utc_time).getTime() -
                    new Date(b.utc_time).getTime()
                );

              const colorIndex =
                Array.from(newSelected).indexOf(fileName) % FILE_COLORS.length;

              setFilesData((prev) => [
                ...prev,
                {
                  fileName,
                  data: sortedData,
                  color: FILE_COLORS[colorIndex],
                  offset: Array.from(newSelected).indexOf(fileName) * 300, // デフォルトオフセット
                },
              ]);

              // 最初のファイルの最初のポイントにマップを移動
              if (filesData.length === 0 && sortedData.length > 0) {
                setViewState((prev) => ({
                  ...prev,
                  longitude: parseFloat(sortedData[0].lon),
                  latitude: parseFloat(sortedData[0].lat),
                }));
              }
            },
            error: (error) => {
              console.error('CSV parsing error:', error);
            },
          });
        } catch (error) {
          console.error('File loading error:', error);
          newSelected.delete(fileName);
          setSelectedFiles(newSelected);
        }
      }
    },
    [selectedFiles, filesData.length]
  );

  // 時空間キューブの生成（ファイル単位で層を統一）
  const spaceTimeCubes = useMemo(() => {
    const cubes: SpaceTimeCube[] = [];

    filesData.forEach((fileData, fileIndex) => {
      const busData = fileData.data;
      if (busData.length === 0) return;

      // 空間グリッドにデータを集約（時間は使わない）
      const gridMap: Record<string, {
        autoCount: number;
        totalCount: number;
        lat: number;
        lon: number;
      }> = {};

      busData.forEach((point) => {
        const lat = parseFloat(point.lat);
        const lon = parseFloat(point.lon);

        // 空間グリッドセルを計算
        const gridLat = Math.floor(lat / spatialGridSize) * spatialGridSize;
        const gridLon = Math.floor(lon / spatialGridSize) * spatialGridSize;

        const key = `${gridLat}_${gridLon}`;

        if (!gridMap[key]) {
          gridMap[key] = {
            autoCount: 0,
            totalCount: 0,
            lat: gridLat + spatialGridSize / 2,
            lon: gridLon + spatialGridSize / 2,
          };
        }

        const cell = gridMap[key];
        cell.totalCount++;
        if (point.mode === 'AUTO') {
          cell.autoCount++;
        }
      });

      // グリッドマップからキューブを生成
      Object.values(gridMap).forEach((cell) => {
        cubes.push({
          lat: cell.lat,
          lon: cell.lon,
          time: new Date(), // ダミー（使用しない）
          autoRatio: cell.totalCount > 0 ? cell.autoCount / cell.totalCount : 0,
          count: cell.totalCount,
          fileIndex,
        });
      });
    });

    return cubes;
  }, [filesData, spatialGridSize]);

  // 3D キューブデータの生成（ファイルごとに個別のオフセット）
  const columnData = useMemo<ColumnData[]>(() => {
    if (spaceTimeCubes.length === 0) return [];

    return spaceTimeCubes.map((cube) => {
      const fileData = filesData[cube.fileIndex];
      // ファイル固有のオフセット高さを使用
      const zOffset = fileData.offset;
      
      return {
        position: [cube.lon, cube.lat] as [number, number],
        elevation: zOffset + boxHeight, // ファイルのオフセット + ボックスの高さ（上面）
        bottomHeight: zOffset, // ボックスの底面の高さ
        color: fileData.color,
        autoRatio: cube.autoRatio,
        fileIndex: cube.fileIndex,
        time: cube.time,
      };
    });
  }, [spaceTimeCubes, boxHeight, filesData]);

  // Deck.GL レイヤー
  const layers = useMemo(() => {
    // 各データポイントから立方体のポリゴンを生成
    const polygons = columnData.map((d) => {
      const size = 0.0002; // ボックスのサイズ（度単位）
      const [lon, lat] = d.position;
      const bottom = d.bottomHeight;
      const top = d.elevation;

      // 立方体の4つの角の座標（3D座標で底面のZ値を指定）
      const corners = [
        [lon - size, lat - size, bottom],
        [lon + size, lat - size, bottom],
        [lon + size, lat + size, bottom],
        [lon - size, lat + size, bottom],
      ];

      return {
        polygon: corners,
        bottom,
        top,
        autoRatio: d.autoRatio,
        color: d.color,
      };
    });

    return [
      new PolygonLayer({
        id: '3d-boxes',
        data: polygons,
        extruded: true,
        wireframe: true,
        pickable: true,
        getPolygon: (d: any) => d.polygon,
        getElevation: (d: any) => d.top - d.bottom, // 底面からの相対的な高さ
        getLineColor: [80, 80, 80],
        getLineWidth: 1,
        getFillColor: (d: any) => {
          // AUTO比率に基づいて色の明るさを調整
          const ratio = d.autoRatio;
          const baseColor = d.color;
          
          // 赤→黄→緑のグラデーション
          let r, g, b;
          if (ratio < 0.5) {
            // 赤から黄色へ
            const t = ratio * 2;
            r = 220 + (250 - 220) * t;
            g = 38 + (204 - 38) * t;
            b = 38 + (21 - 38) * t;
          } else {
            // 黄色から緑へ
            const t = (ratio - 0.5) * 2;
            r = 250 + (34 - 250) * t;
            g = 204 + (197 - 204) * t;
            b = 21 + (94 - 21) * t;
          }
          
          // ファイルごとの色を少し混ぜる
          r = r * 0.7 + baseColor[0] * 0.3;
          g = g * 0.7 + baseColor[1] * 0.3;
          b = b * 0.7 + baseColor[2] * 0.3;
          
          return [r, g, b, 200];
        },
        elevationScale: 1,
      }),
    ];
  }, [columnData]);

  // 統計情報
  const totalStats = useMemo(() => {
    let totalAutoRatio = 0;
    let totalCount = 0;

    spaceTimeCubes.forEach((cube) => {
      totalAutoRatio += cube.autoRatio * cube.count;
      totalCount += cube.count;
    });

    return {
      totalCubes: spaceTimeCubes.length,
      totalPoints: totalCount,
      avgAutoRatio: totalCount > 0 ? totalAutoRatio / totalCount : 0,
      fileCount: filesData.length,
    };
  }, [spaceTimeCubes, filesData.length]);

  // SSRハイドレーションエラーを防ぐ
  if (!isMounted) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-lg">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {/* 左パネル */}
      <div className="w-64 bg-gray-100 p-4 overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">ファイル選択（複数可）</h2>
        <ul className="space-y-2">
          {availableFiles.map((file) => (
            <li key={file}>
              <label className="flex items-center gap-2 px-3 py-2 bg-white rounded hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedFiles.has(file)}
                  onChange={() => handleFileToggle(file)}
                  className="w-4 h-4"
                />
                <span className="flex-1">{file}</span>
                {selectedFiles.has(file) && (
                  <div
                    className="w-4 h-4 rounded-full"
                    style={{
                      backgroundColor: `rgb(${filesData.find((f) => f.fileName === file)?.color?.join(',') || '0,0,0'})`,
                    }}
                  />
                )}
              </label>
            </li>
          ))}
        </ul>

        {/* 各ファイルのオフセット設定 */}
        {filesData.length > 0 && (
          <div className="mt-4 p-3 bg-white rounded">
            <h3 className="font-semibold mb-3">ファイル別オフセット</h3>
            {filesData.map((fileData) => (
              <div key={fileData.fileName} className="mb-4">
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{
                      backgroundColor: `rgb(${fileData.color.join(',')})`,
                    }}
                  />
                  <span className="text-xs font-medium">
                    {fileData.fileName}
                  </span>
                </div>
                <input
                  type="range"
                  value={fileData.offset}
                  onChange={(e) =>
                    updateFileOffset(fileData.fileName, Number(e.target.value))
                  }
                  min="-500"
                  max="2000"
                  step="50"
                  className="w-full"
                />
                <div className="text-xs text-gray-600 text-center">
                  {fileData.offset}m
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 区間距離設定 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">空間グリッド設定</h3>
          
          <label className="text-xs text-gray-600 block mb-1">
            グリッドサイズ (度)
          </label>
          <input
            type="number"
            value={spatialGridSize}
            onChange={(e) => setSpatialGridSize(Number(e.target.value))}
            min="0.0001"
            max="0.01"
            step="0.0001"
            className="w-full px-2 py-1 border rounded mb-3"
          />
          <p className="text-xs text-gray-500">
            ≈ {(spatialGridSize * 111000).toFixed(0)}m
          </p>
        </div>

        {/* 層間隔設定 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">層間隔 (m)</h3>
          <input
            type="range"
            value={layerSpacing}
            onChange={(e) => setLayerSpacing(Number(e.target.value))}
            min="100"
            max="1000"
            step="50"
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span>100m</span>
            <span className="font-semibold">{layerSpacing}m</span>
            <span>1000m</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            ファイル間の垂直距離
          </p>
        </div>

        {/* オフセット高さ設定 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">基準オフセット高さ (m)</h3>
          <input
            type="range"
            value={baseOffset}
            onChange={(e) => setBaseOffset(Number(e.target.value))}
            min="-500"
            max="2000"
            step="50"
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span>-500m</span>
            <span className="font-semibold">{baseOffset}m</span>
            <span>2000m</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            全体の垂直位置
          </p>
        </div>

        {/* ボックス高さ設定 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">ボックス高さ (m)</h3>
          <input
            type="range"
            value={boxHeight}
            onChange={(e) => setBoxHeight(Number(e.target.value))}
            min="20"
            max="300"
            step="20"
            className="w-full"
          />
          <div className="flex justify-between text-xs text-gray-600">
            <span>20m</span>
            <span className="font-semibold">{boxHeight}m</span>
            <span>300m</span>
          </div>
        </div>

        {/* カメラコントロール */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">カメラ</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-gray-600">傾き (Pitch)</label>
              <input
                type="range"
                min="0"
                max="85"
                value={viewState.pitch}
                onChange={(e) =>
                  setViewState((prev) => ({
                    ...prev,
                    pitch: Number(e.target.value),
                  }))
                }
                className="w-full"
              />
              <span className="text-xs">{viewState.pitch}°</span>
            </div>
            <div>
              <label className="text-xs text-gray-600">回転 (Bearing)</label>
              <input
                type="range"
                min="0"
                max="360"
                value={viewState.bearing}
                onChange={(e) =>
                  setViewState((prev) => ({
                    ...prev,
                    bearing: Number(e.target.value),
                  }))
                }
                className="w-full"
              />
              <span className="text-xs">{viewState.bearing}°</span>
            </div>
          </div>
        </div>

        {/* 統計情報 */}
        {filesData.length > 0 && (
          <div className="mt-4 p-3 bg-white rounded">
            <h3 className="font-semibold mb-2">統計情報</h3>
            <p className="text-sm text-gray-600">
              ファイル数: {totalStats.fileCount}
            </p>
            <p className="text-sm text-gray-600">
              キューブ数: {totalStats.totalCubes}
            </p>
            <p className="text-sm text-gray-600">
              総ポイント数: {totalStats.totalPoints}
            </p>
            <p className="text-sm text-gray-600">
              平均AUTO比率: {(totalStats.avgAutoRatio * 100).toFixed(1)}%
            </p>
          </div>
        )}

        {/* 凡例 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">空間キューブ</h3>
          <div className="space-y-1">
            <p className="text-xs text-gray-600 mb-2">
              <strong>X・Y軸:</strong> 位置（緯度・経度）
            </p>
            <p className="text-xs text-gray-600 mb-2">
              <strong>Z軸:</strong> ファイル層
            </p>
            <p className="text-xs text-gray-600 mb-2">
              <strong>色:</strong> AUTO比率
            </p>
            <div className="flex items-center gap-2 ml-2">
              <div className="w-6 h-2 bg-red-600"></div>
              <span className="text-xs">低 (0%)</span>
            </div>
            <div className="flex items-center gap-2 ml-2">
              <div className="w-6 h-2 bg-yellow-400"></div>
              <span className="text-xs">中 (50%)</span>
            </div>
            <div className="flex items-center gap-2 ml-2">
              <div className="w-6 h-2 bg-green-500"></div>
              <span className="text-xs">高 (100%)</span>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              各キューブは空間グリッドを表します
            </p>
          </div>
        </div>
      </div>

      {/* マップ */}
      <div className="flex-1 relative">
        {isMounted && (
          <DeckGL
            viewState={viewState}
            onViewStateChange={({ viewState }) => setViewState(viewState as MapViewStateType)}
            controller={true}
            layers={layers}
            getTooltip={({ object }: any) => 
              object && {
                html: `
                  <div>
                    <strong>空間キューブ</strong><br/>
                    ファイル: ${filesData[object.fileIndex]?.fileName || 'Unknown'}<br/>
                    AUTO比率: ${(object.autoRatio * 100).toFixed(1)}%
                  </div>
                `,
                style: {
                  backgroundColor: '#333',
                  color: '#fff',
                  padding: '8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                },
              }
            }
          >
            <Map
              mapStyle="https://tile.openstreetmap.jp/styles/osm-bright-ja/style.json"
            />
          </DeckGL>
        )}
      </div>
    </div>
  );
}
