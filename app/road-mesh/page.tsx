'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { PolygonLayer } from '@deck.gl/layers';
import type { MapViewState as MapViewStateType } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';

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

const FEATURE_COLORS: [number, number, number][] = [
  [255, 200, 0], // オレンジ
  [59, 130, 246], // blue
  [34, 197, 94], // green
  [245, 158, 11], // amber
  [139, 92, 246], // violet
  [236, 72, 153], // pink
];

export default function RoadMeshPage() {
  const [isMounted, setIsMounted] = useState(false);
  const [geoJsonData, setGeoJsonData] = useState<GeoJSONData | null>(null);
  const [featureOffsets, setFeatureOffsets] = useState<FeatureOffset[]>([]);
  const [roadWidth, setRoadWidth] = useState<number>(0.00009); // 約9m
  const [extrusionHeight, setExtrusionHeight] = useState<number>(50); // 押し出し高さ
  const [baseElevation, setBaseElevation] = useState<number>(80); // 基準の地面からの高さ
  const [viewState, setViewState] = useState<MapViewStateType>({
    longitude: 140.5307,
    latitude: 36.5388,
    zoom: 14,
    pitch: 60,
    bearing: 0,
  });

  // featureのオフセット更新
  const updateFeatureOffset = useCallback((index: number, offset: number) => {
    setFeatureOffsets((prev) =>
      prev.map((feature) =>
        feature.index === index ? { ...feature, offset } : feature
      )
    );
  }, []);

  useEffect(() => {
    setIsMounted(true);

    fetch('/data/base-route/northbound-routes.json')
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
        
        // 最初の座標でビューを初期化
        const firstCoords = data.features[0]?.geometry?.coordinates?.[0];
        if (firstCoords) {
          const [lon, lat] = firstCoords;
          setViewState((prev) => ({ ...prev, longitude: lon, latitude: lat }));
        }
      })
      .catch((err) => console.error('GeoJSON読み込みエラー:', err));
  }, []);

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
    if (!isMounted || roadSegments.length === 0) return [];

    return roadSegments.map((segment) => {
      const featureOffset = offsetMap[segment.featureIndex];
      const color = featureOffset?.color || [255, 200, 0];
      const fillColor: [number, number, number, number] = [color[0], color[1], color[2], 200];

      return new PolygonLayer({
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
      });
    });
  }, [roadSegments, offsetMap, isMounted]);

  if (!isMounted) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-lg">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen">
      {/* コントロールパネル */}
      <div className="absolute top-4 left-4 z-10 bg-white p-4 rounded-lg shadow-lg space-y-4 max-w-xs max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold">道路メッシュ設定</h2>
        
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

        <div>
          <label className="block text-sm font-medium mb-1">
            基準Z軸位置: {baseElevation}m
          </label>
          <input
            type="range"
            min="0"
            max="200"
            step="5"
            value={baseElevation}
            onChange={(e) => setBaseElevation(parseInt(e.target.value))}
            className="w-full"
          />
          <p className="text-xs text-gray-500 mt-1">
            全体の基準高さ
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
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

        {/* 各featureのオフセット制御 */}
        {featureOffsets.length > 0 && (
          <div className="pt-2 border-t">
            <h3 className="text-sm font-semibold mb-2">各ルートのZ軸オフセット</h3>
            {featureOffsets.map((feature) => (
              <div key={feature.index} className="mb-3 p-2 bg-gray-50 rounded">
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
                <p className="text-xs text-gray-500 mt-1">
                  最終Z: {baseElevation + feature.offset + extrusionHeight}m
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="pt-2 border-t">
          <p className="text-xs text-gray-600">
            northbound-routes.jsonのLineStringデータから生成された3D道路メッシュ
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Features: {featureOffsets.length}
          </p>
        </div>
      </div>

      {/* DeckGL + MapLibre */}
      <DeckGL
        viewState={viewState}
        onViewStateChange={(e: any) => setViewState(e.viewState)}
        controller={true}
        layers={layers}
        getTooltip={(info: any) =>
          info.object && {
            html: `<div>
              <div>道路セグメント</div>
              <div>底面: ${info.object.polygon[0][2]}m</div>
              <div>上面: ${info.object.topElevation}m</div>
            </div>`,
            style: {
              backgroundColor: '#333',
              color: '#fff',
              padding: '8px',
              borderRadius: '4px',
            },
          }
        }
      >
        <Map
          mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
          attributionControl={false}
        />
      </DeckGL>
    </div>
  );
}
