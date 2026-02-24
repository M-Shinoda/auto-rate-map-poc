'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { PolygonLayer } from '@deck.gl/layers';
import type { MapViewState as MapViewStateType } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import { getTripFiles } from './actions';

// DeckGLとMapをクライアントサイドでのみロード
const DeckGL = dynamic(() => import('@deck.gl/react').then((mod) => mod.default), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full">マップを読み込み中...</div>,
});

const Map = dynamic(() => import('react-map-gl/maplibre').then((mod) => mod.Map), {
  ssr: false,
});

interface GeoJSONData {
  type: string;
  features: Array<{
    type: string;
    properties: Record<string, any>;
    geometry: {
      type: string;
      coordinates: number[][];
    };
  }>;
}

interface RoadSegment {
  polygon: number[][]; // 3D座標 [lon, lat, z]
  topElevation: number; // 上面の高さ
  featureIndex: number;
}

interface FeatureOffset {
  index: number;
  offset: number;
  color: [number, number, number];
}

interface TripFile {
  filename: string;
  displayName: string;
  routeKey: number;
  fullDate: string;
}

interface TripData {
  vehicle_key: string;
  full_date: string;
  trip_key: string;
  route_key: number;
  utc_time: string;
  vehicle_id: string;
  mode: string;
  lat: number;
  lon: number;
}

interface TripSegment {
  coordinates: number[][];
  autoRate: number;
  segmentIndex: number;
  tripFileIndex: number;
  actualDistance: number;
}

/**
 * LineStringから道路ポリゴンを生成
 * @param coordinates - LineStringの座標配列
 * @param width - 道路の幅（度単位）
 * @param baseHeight - 底面の高さ（メートル）
 * @param topHeight - 上面の高さ（メートル）
 * @param featureIndex - Feature識別用インデックス
 */
function generateRoadPolygons(
  coordinates: number[][],
  width: number,
  baseHeight: number,
  topHeight: number,
  featureIndex: number
): RoadSegment {
  const coordsCount = coordinates.length;
  const halfWidth = width / 2;
  
  // 左右の座標を事前に確保
  const leftSide: number[][] = new Array(coordsCount);
  const rightSide: number[][] = new Array(coordsCount);
  
  for (let i = 0; i < coordsCount; i++) {
    const [lon, lat] = coordinates[i];
    
    // 接線ベクトルの計算
    let dx: number, dy: number;
    
    if (i === 0) {
      const next = coordinates[1];
      dx = next[0] - lon;
      dy = next[1] - lat;
    } else if (i === coordsCount - 1) {
      const prev = coordinates[i - 1];
      dx = lon - prev[0];
      dy = lat - prev[1];
    } else {
      const prev = coordinates[i - 1];
      const next = coordinates[i + 1];
      dx = next[0] - prev[0];
      dy = next[1] - prev[1];
    }
    
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length === 0) continue;
    
    // 法線ベクトル（正規化済み）
    const invLength = 1 / length;
    const perpDx = -dy * invLength * halfWidth;
    const perpDy = dx * invLength * halfWidth;
    
    // 3D座標として格納
    leftSide[i] = [lon - perpDx, lat - perpDy, baseHeight];
    rightSide[i] = [lon + perpDx, lat + perpDy, baseHeight];
  }
  
  // ポリゴンの構築（右側を反転して結合）
  const polygon = leftSide.concat(rightSide.reverse());
  
  return {
    polygon,
    topElevation: topHeight,
    featureIndex,
  };
}

/**
 * 2点間の距離を計算（メートル）
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // 地球の半径（メートル）
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * AUTO率に応じた色を計算（0=赤、100%=緑）
 */
function getColorByAutoRate(autoRate: number): [number, number, number] {
  const red = Math.round(255 * (1 - autoRate));
  const green = Math.round(255 * autoRate);
  return [red, green, 0];
}

/**
 * トリップデータをセグメントに分割
 */
function segmentTripData(
  tripData: TripData[],
  targetDistance: number,
  tripFileIndex: number
): { segments: TripSegment[], actualDistance: number } {
  if (tripData.length < 2) return { segments: [], actualDistance: 0 };

  // 全体の距離を計算
  let totalDistance = 0;
  const distances: number[] = [0];
  for (let i = 1; i < tripData.length; i++) {
    const dist = calculateDistance(
      tripData[i - 1].lat,
      tripData[i - 1].lon,
      tripData[i].lat,
      tripData[i].lon
    );
    totalDistance += dist;
    distances.push(totalDistance);
  }

  // セグメント数を計算（均等分割）
  const numSegments = Math.max(1, Math.round(totalDistance / targetDistance));
  const actualSegmentDistance = totalDistance / numSegments;

  const segments: TripSegment[] = [];
  
  for (let segIdx = 0; segIdx < numSegments; segIdx++) {
    const startDist = segIdx * actualSegmentDistance;
    const endDist = (segIdx + 1) * actualSegmentDistance;
    
    // このセグメントに含まれるポイントを抽出
    const segmentPoints: TripData[] = [];
    let autoCount = 0;
    
    for (let i = 0; i < tripData.length; i++) {
      if (distances[i] >= startDist && distances[i] <= endDist) {
        segmentPoints.push(tripData[i]);
        if (tripData[i].mode === 'AUTO') autoCount++;
      }
    }
    
    if (segmentPoints.length >= 2) {
      const coordinates = segmentPoints.map(p => [p.lon, p.lat]);
      const autoRate = segmentPoints.length > 0 ? autoCount / segmentPoints.length : 0;
      
      segments.push({
        coordinates,
        autoRate,
        segmentIndex: segIdx,
        tripFileIndex,
        actualDistance: actualSegmentDistance,
      });
    }
  }
  
  return { segments, actualDistance: actualSegmentDistance };
}

const FEATURE_COLORS: [number, number, number][] = [
  [200, 200, 200], // 薄い灰色
  [200, 200, 200], // 薄い灰色
  [200, 200, 200], // 薄い灰色
  [200, 200, 200], // 薄い灰色
  [200, 200, 200], // 薄い灰色
  [200, 200, 200], // 薄い灰色
];

export default function RoadMeshPage() {
  const [isMounted, setIsMounted] = useState(false);
  const [routeType, setRouteType] = useState<'northbound' | 'southbound'>('northbound');
  const [geoJsonData, setGeoJsonData] = useState<GeoJSONData | null>(null);
  const [featureOffsets, setFeatureOffsets] = useState<FeatureOffset[]>([]);
  const [tripFiles, setTripFiles] = useState<TripFile[]>([]);
  const [selectedTripFiles, setSelectedTripFiles] = useState<{
    northbound: string[];
    southbound: string[];
  }>({ northbound: [], southbound: [] });
  const [tripSegments, setTripSegments] = useState<TripSegment[]>([]);
  const [segmentDistance, setSegmentDistance] = useState<number>(50); // 目標セグメント距離(m)
  const [actualSegmentDistance, setActualSegmentDistance] = useState<number>(0);
  const [tripZOffset, setTripZOffset] = useState<number>(100); // トリップ間のZ軸オフセット
  const [roadWidth, setRoadWidth] = useState<number>(0.00009); // 約9m
  const [extrusionHeight, setExtrusionHeight] = useState<number>(30); // 押し出し高さ
  const [baseElevation] = useState<number>(0); // 基準の地面からの高さ（固定）
  const [viewState, setViewState] = useState<MapViewStateType>({
    longitude: 140.5257,
    latitude: 36.5384,
    zoom: 15,
    pitch: 45,
    bearing: 0,
  });

  // ビューキューブの中心座標
  const VIEW_CENTER = {
    longitude: 140.527704,
    latitude: 36.538856,
  };

  // ビューキューブのプリセット
  const viewPresets = {
    top: { pitch: 0, bearing: 0 },
    front: { pitch: 60, bearing: 0 },
    back: { pitch: 60, bearing: 180 },
    left: { pitch: 60, bearing: 270 },
    right: { pitch: 60, bearing: 90 },
    frontLeft: { pitch: 60, bearing: 315 },
    frontRight: { pitch: 60, bearing: 45 },
    backLeft: { pitch: 60, bearing: 225 },
    backRight: { pitch: 60, bearing: 135 },
  };

  // ビュー切り替え関数
  const switchView = useCallback((preset: keyof typeof viewPresets) => {
    const { pitch, bearing } = viewPresets[preset];
    setViewState(prev => ({
      ...prev,
      longitude: VIEW_CENTER.longitude,
      latitude: VIEW_CENTER.latitude,
      pitch,
      bearing,
      zoom: 14.5,
    }));
  }, []);

  // featureのオフセット更新
  const updateFeatureOffset = useCallback((index: number, offset: number) => {
    setFeatureOffsets((prev) =>
      prev.map((feature) =>
        feature.index === index ? { ...feature, offset } : feature
      )
    );
  }, []);

  // 現在のルートタイプに対応するトリップファイルを取得
  const availableTripFiles = useMemo(() => {
    const targetRouteKey = routeType === 'northbound' ? 10 : 11;
    return tripFiles.filter(file => file.routeKey === targetRouteKey);
  }, [routeType, tripFiles]);

  // トリップファイルのトグル（選択/解除）
  const toggleTripFile = useCallback((filename: string) => {
    setSelectedTripFiles((prev) => {
      const currentFiles = prev[routeType];
      if (currentFiles.includes(filename)) {
        return {
          ...prev,
          [routeType]: currentFiles.filter(f => f !== filename)
        };
      } else {
        return {
          ...prev,
          [routeType]: [...currentFiles, filename]
        };
      }
    });
  }, [routeType]);

  // 現在のルートタイプで選択されているトリップファイル
  const currentSelectedFiles = useMemo(() => {
    return selectedTripFiles[routeType];
  }, [selectedTripFiles, routeType]);

  // トリップファイルを動的にロード
  useEffect(() => {
    getTripFiles().then(files => {
      setTripFiles(files);
    }).catch(err => {
      console.error('トリップファイルの取得エラー:', err);
    });
  }, []);

  // トリップデータの読み込みと処理
  useEffect(() => {
    // 現在のルートタイプで選択されているファイルのみを読み込む
    if (currentSelectedFiles.length === 0) {
      setTripSegments([]);
      setActualSegmentDistance(0);
      return;
    }

    Promise.all(
      currentSelectedFiles.map((filename, index) =>
        fetch(`/data/trips/${filename}`)
          .then(res => res.text())
          .then(text => {
            const lines = text.trim().split('\n');
            const headers = lines[0].split(',');
            const data: TripData[] = lines.slice(1)
              .map(line => {
                const values = line.split(',');
                // 必要なカラム数があるかチェック
                if (values.length < 9) return null;
                
                const lat = parseFloat(values[7]);
                const lon = parseFloat(values[8]);
                
                // 座標が有効かチェック
                if (isNaN(lat) || isNaN(lon)) return null;
                
                return {
                  vehicle_key: values[0],
                  full_date: values[1],
                  trip_key: values[2],
                  route_key: parseInt(values[3]) || 0,
                  utc_time: values[4] || '',
                  vehicle_id: values[5],
                  mode: values[6],
                  lat,
                  lon,
                };
              })
              .filter((d): d is TripData => d !== null && d.utc_time !== ''); // nullと空のutc_timeを除外
            
            // utc_timeでソート
            data.sort((a, b) => a.utc_time.localeCompare(b.utc_time));
            
            return { data, filename, index };
          })
      )
    ).then(results => {
      let allSegments: TripSegment[] = [];
      let avgActualDistance = 0;
      
      results.forEach(({ data, index }) => {
        const { segments, actualDistance } = segmentTripData(data, segmentDistance, index);
        allSegments = allSegments.concat(segments);
        avgActualDistance += actualDistance;
      });
      
      if (results.length > 0) {
        avgActualDistance /= results.length;
      }
      
      setTripSegments(allSegments);
      setActualSegmentDistance(avgActualDistance);
    }).catch(err => console.error('トリップデータ読み込みエラー:', err));
  }, [currentSelectedFiles, segmentDistance]);

  useEffect(() => {
    setIsMounted(true);

    const filename = routeType === 'northbound' ? 'northbound-routes.json' : 'southbound-routes.json';
    fetch(`/data/base-route/${filename}`)
      .then((res) => res.json())
      .then((data: GeoJSONData) => {
        setGeoJsonData(data);
        
        // 各featureにオフセットと色を割り当て
        const colorCount = FEATURE_COLORS.length;
        const offsets: FeatureOffset[] = data.features.map((_, index) => ({
          index,
          offset: index * 50,
          color: FEATURE_COLORS[index % colorCount],
        }));
        setFeatureOffsets(offsets);
        
        // // 最初の座標でビューを初期化
        // const firstCoords = data.features[0]?.geometry?.coordinates?.[0];
        // if (firstCoords) {
        //   const [lon, lat] = firstCoords;
        //   setViewState((prev) => ({ ...prev, longitude: lon, latitude: lat }));
        // }
      })
      .catch((err) => console.error('GeoJSON読み込みエラー:', err));
  }, [routeType]);

  // 道路セグメントの生成
  const roadSegments = useMemo(() => {
    if (!geoJsonData || featureOffsets.length === 0) return [];

    const segments: RoadSegment[] = [];
    
    geoJsonData.features.forEach((feature, index) => {
      if (feature.geometry.type !== 'LineString' || feature.geometry.coordinates.length < 2) {
        return;
      }
      
      const featureOffset = featureOffsets[index];
      if (!featureOffset) return;
      
      const baseHeight = baseElevation + featureOffset.offset;
      const topHeight = baseHeight + extrusionHeight;
      
      const segment = generateRoadPolygons(
        feature.geometry.coordinates,
        roadWidth,
        baseHeight,
        topHeight,
        index
      );
      segments.push(segment);
    });
    
    return segments;
  }, [geoJsonData, roadWidth, baseElevation, extrusionHeight, featureOffsets]);

  // 高速アクセス用のオフセットマップ
  const offsetMap = useMemo(() => {
    const map: Record<number, FeatureOffset> = {};
    featureOffsets.forEach(offset => {
      map[offset.index] = offset;
    });
    return map;
  }, [featureOffsets]);

  // PolygonLayerの作成
  const layers = useMemo(() => {
    if (!isMounted) return [];

    const allLayers = [];

    // 基本ルートのレイヤー
    if (roadSegments.length > 0) {
      roadSegments.forEach((segment) => {
        const featureOffset = offsetMap[segment.featureIndex];
        const color = featureOffset?.color || [255, 200, 0];
        const fillColor: [number, number, number, number] = [color[0], color[1], color[2], 200];

        allLayers.push(
          new PolygonLayer({
            id: `road-mesh-layer-${segment.featureIndex}`,
            data: [segment],
            getPolygon: (d: RoadSegment) => d.polygon,
            getElevation: (d: RoadSegment) => d.topElevation - d.polygon[0][2],
            getFillColor: fillColor,
            extruded: true,
            wireframe: false,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 0, 150],
            elevationScale: 1,
          })
        );
      });
    }

    // トリップデータのレイヤー
    if (tripSegments.length > 0) {
      tripSegments.forEach((segment) => {
        const color = getColorByAutoRate(segment.autoRate);
        const fillColor: [number, number, number, number] = [color[0], color[1], color[2], 220];
        
        // Z軸オフセット（基本ルートからtripZOffsetずつ間隔を開けて積み重ね）
        const zOffset = baseElevation + extrusionHeight + (tripZOffset * (segment.tripFileIndex + 1));
        const topHeight = zOffset + 30; // トリップの厚み
        
        // セグメントからポリゴンを生成
        const tripPolygon = generateRoadPolygons(
          segment.coordinates,
          roadWidth * 0.8, // 少し細く
          zOffset,
          topHeight,
          segment.segmentIndex
        );

        allLayers.push(
          new PolygonLayer({
            id: `trip-segment-${segment.tripFileIndex}-${segment.segmentIndex}`,
            data: [tripPolygon],
            getPolygon: (d: RoadSegment) => d.polygon,
            getElevation: (d: RoadSegment) => d.topElevation - d.polygon[0][2],
            getFillColor: fillColor,
            extruded: true,
            wireframe: false,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 255, 255, 200],
            elevationScale: 1,
          })
        );
      });
    }

    return allLayers;
  }, [roadSegments, offsetMap, tripSegments, isMounted, baseElevation, extrusionHeight, roadWidth, tripZOffset]);

  if (!isMounted) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-lg">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen">
      {/* ビューキューブ */}
      <div className="absolute top-4 right-4 z-20 bg-white p-2 rounded-lg shadow-lg">
        <div className="text-xs font-semibold text-center mb-2 text-gray-700">ビュー</div>
        <div className="grid grid-cols-3 gap-1 w-32 h-32">
          {/* 上段 */}
          <button
            onClick={() => switchView('backLeft')}
            className="bg-gray-200 hover:bg-blue-400 text-xs font-medium rounded transition-colors flex items-center justify-center"
            title="後左"
          >
            ↖
          </button>
          <button
            onClick={() => switchView('back')}
            className="bg-gray-300 hover:bg-blue-500 text-xs font-semibold rounded transition-colors flex items-center justify-center"
            title="後"
          >
            後
          </button>
          <button
            onClick={() => switchView('backRight')}
            className="bg-gray-200 hover:bg-blue-400 text-xs font-medium rounded transition-colors flex items-center justify-center"
            title="後右"
          >
            ↗
          </button>
          
          {/* 中段 */}
          <button
            onClick={() => switchView('left')}
            className="bg-gray-300 hover:bg-blue-500 text-xs font-semibold rounded transition-colors flex items-center justify-center"
            title="左"
          >
            左
          </button>
          <button
            onClick={() => switchView('top')}
            className="bg-blue-100 hover:bg-blue-600 hover:text-white text-xs font-bold rounded transition-colors flex items-center justify-center border-2 border-blue-400"
            title="上"
          >
            上
          </button>
          <button
            onClick={() => switchView('right')}
            className="bg-gray-300 hover:bg-blue-500 text-xs font-semibold rounded transition-colors flex items-center justify-center"
            title="右"
          >
            右
          </button>
          
          {/* 下段 */}
          <button
            onClick={() => switchView('frontLeft')}
            className="bg-gray-200 hover:bg-blue-400 text-xs font-medium rounded transition-colors flex items-center justify-center"
            title="前左"
          >
            ↙
          </button>
          <button
            onClick={() => switchView('front')}
            className="bg-gray-300 hover:bg-blue-500 text-xs font-semibold rounded transition-colors flex items-center justify-center"
            title="前"
          >
            前
          </button>
          <button
            onClick={() => switchView('frontRight')}
            className="bg-gray-200 hover:bg-blue-400 text-xs font-medium rounded transition-colors flex items-center justify-center"
            title="後右"
          >
            ↘
          </button>
        </div>
        <div className="text-xs text-center mt-2 text-gray-500">
          {viewState.bearing.toFixed(0)}° / {viewState.pitch.toFixed(0)}°
        </div>
      </div>

      {/* コントロールパネル */}
      <div className="absolute top-4 left-4 z-10 bg-white p-4 rounded-lg shadow-lg space-y-4 max-w-xs max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold">道路メッシュ設定</h2>
        {/* ルート切り替えボタン */}
        <div className="flex gap-2">
          <button
            onClick={() => setRouteType('northbound')}
            className={`flex-1 px-3 py-2 rounded font-medium text-sm transition-colors ${
              routeType === 'northbound'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            北回り
          </button>
          <button
            onClick={() => setRouteType('southbound')}
            className={`flex-1 px-3 py-2 rounded font-medium text-sm transition-colors ${
              routeType === 'southbound'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            南回り
          </button>
        </div>
        
        {/* トリップ選択 */}
        <div className="border-t pt-3">
          <label className="block text-sm font-semibold mb-2">
            トリップデータ選択（複数選択可）
          </label>
          <div className="space-y-2">
            {availableTripFiles.map((tripFile) => {
              const selectedIndex = currentSelectedFiles.indexOf(tripFile.filename);
              const isSelected = selectedIndex !== -1;
              const layerNumber = selectedIndex + 1; // 1から始まる番号
              
              return (
                <button
                  key={tripFile.filename}
                  onClick={() => toggleTripFile(tripFile.filename)}
                  className={`w-full px-3 py-2 rounded text-sm text-left transition-colors ${
                    isSelected
                      ? 'bg-green-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className={`w-4 h-4 border-2 rounded flex items-center justify-center ${
                      isSelected
                        ? 'border-white bg-white'
                        : 'border-gray-400'
                    }`}>
                      {isSelected && (
                        <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        {isSelected && (
                          <span className="inline-flex items-center justify-center w-5 h-5 text-xs font-bold bg-blue-500 text-white rounded-full">
                            {layerNumber}
                          </span>
                        )}
                        <span>{tripFile.displayName}</span>
                      </div>
                      <p className="text-xs mt-1 opacity-90 h-4">
                        {isSelected ? `下から${layerNumber}層目` : '\u00A0'}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {currentSelectedFiles.length > 0 && (
            <p className="text-xs text-gray-500 mt-2">
              選択中: {currentSelectedFiles.length}件
            </p>
          )}
        </div>
        
        {/* トリップセグメント設定 */}
        <div className="border-t pt-3">
          <h3 className="text-sm font-semibold mb-2">トリップデータ設定</h3>
          
          <div className="mb-3">
            <label className="block text-xs font-medium mb-1">
              目標セグメント距離: {segmentDistance}m
            </label>
            <input
              type="range"
              min="50"
              max="500"
              step="10"
              value={segmentDistance}
              onChange={(e) => setSegmentDistance(parseInt(e.target.value))}
              className="w-full"
            />
            {actualSegmentDistance > 0 && (
              <p className="text-xs text-gray-500 mt-1">
                実際のセグメント距離: {actualSegmentDistance.toFixed(1)}m
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">
              トリップ間Z軸間隔: {tripZOffset}m
            </label>
            <input
              type="range"
              min="40"
              max="250"
              step="10"
              value={tripZOffset}
              onChange={(e) => setTripZOffset(parseInt(e.target.value))}
              className="w-full"
            />
            <p className="text-xs text-gray-500 mt-1">
              複数選択時の積み重ね間隔
            </p>
          </div>

          {tripSegments.length > 0 && (
            <div className="mt-3 p-2 bg-blue-50 rounded">
              <p className="text-xs text-gray-700">
                トリップセグメント: {tripSegments.length}個
              </p>
              <div className="flex items-center gap-2 mt-1">
                <div className="flex-1 h-3 rounded" 
                  style={{
                    background: 'linear-gradient(to right, rgb(255,0,0), rgb(255,255,0), rgb(0,255,0))'
                  }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">
                赤: AUTO 0% → 緑: AUTO 100%
              </p>
            </div>
          )}
        </div>
        
        <div>
          <label className="block text-sm font-medium mb-1">
            道路幅: {(roadWidth * 100000).toFixed(1)}m
          </label>
          <input
            type="range"
            min="0.00001"
            max="0.0002"
            step="0.00001"
            value={roadWidth}
            onChange={(e) => setRoadWidth(parseFloat(e.target.value))}
            className="w-full"
          />
        </div>

        {/* 基本ルートの設定 */}
        {featureOffsets.length > 0 && (
          <div className="border-t pt-3">
            <h3 className="text-sm font-semibold mb-3">基本ルートの設定</h3>
            
            {/* 押し出し高さ */}
            <div className="mb-3">
              <label className="block text-xs font-medium mb-1">
                押し出し高さ: {extrusionHeight}m
              </label>
              <input
                type="range"
                min="0"
                max="200"
                step="5"
                value={extrusionHeight}
                onChange={(e) => setExtrusionHeight(parseInt(e.target.value))}
                className="w-full"
              />
              <p className="text-xs text-gray-500 mt-1">
                基準高さからの押し出し高さ
              </p>
            </div>

            {/* Z軸オフセット */}
            <div>
              <label className="block text-xs font-medium mb-2">Z軸オフセット</label>
              {featureOffsets.map((feature) => (
                <div key={feature.index}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: `rgb(${feature.color.join(',')})` }}
                    />
                    <label className="text-xs font-medium">
                      ルート {feature.index + 1}: {feature.offset}m
                    </label>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="300"
                    step="10"
                    value={feature.offset}
                    onChange={(e) => updateFeatureOffset(feature.index, parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-xs text-gray-600">
            {routeType === 'northbound' ? '北回り' : '南回り'}ルートのLineStringデータから生成された3D道路メッシュ
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Features: {featureOffsets.length}
          </p>
          {tripSegments.length > 0 && (
            <p className="text-xs text-blue-600 mt-1">
              トリップデータ表示中
            </p>
          )}
        </div>
      </div>

      {/* DeckGL + MapLibre */}
      <DeckGL
        viewState={viewState}
        onViewStateChange={(e: any) => setViewState(e.viewState)}
        controller={{
          scrollZoom: true,
          dragPan: true,
          dragRotate: true,
          doubleClickZoom: true,
          touchZoom: true,
          touchRotate: true,
          keyboard: true,
          inertia: true,
          maxPitch: 89, // 最大傾斜角度を89度に設定（90度だと真横になりすぎるため）
          minPitch: 0,
        }}
        layers={layers}
        getTooltip={(info: any) => {
          console.log('Tooltip info:', info);

          if (!info.object) return null;
          
          const isTrip = info.layer?.id?.startsWith('trip-segment');
          
          if (isTrip) {
            // トリップセグメントの場合
            const segmentData = tripSegments.find(s => 
              info.layer.id === `trip-segment-${s.tripFileIndex}-${s.segmentIndex}`
            );
            
            return {
              html: `<div>
                <div><strong>トリップセグメント</strong></div>
                ${segmentData ? `<div>AUTO率: ${(segmentData.autoRate * 100).toFixed(1)}%</div>` : ''}
              </div>`,
              style: {
                backgroundColor: '#1e3a8a',
                color: '#fff',
                padding: '8px',
                borderRadius: '4px',
              },
            };
          } else {
            // 基本ルートの場合
            return {
              html: `<div>
                <div>道路セグメント</div>
              </div>`,
              style: {
                backgroundColor: '#333',
                color: '#fff',
                padding: '8px',
                borderRadius: '4px',
              },
            };
          }
        }}
      >
        <Map
          mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
          attributionControl={false}
        />
      </DeckGL>
    </div>
  );
}
