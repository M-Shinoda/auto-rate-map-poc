"use client";

import { useState, useCallback, useMemo } from "react";
import Map, { Source, Layer } from "react-map-gl/maplibre";
import Papa from "papaparse";
import "maplibre-gl/dist/maplibre-gl.css";
import { calculateGeodesicDistance } from "@/lib/geodesic";

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

interface Segment {
  startIndex: number;
  endIndex: number;
  distance: number;
  autoRatio: number;
}

interface GeoJSONFeature {
  type: "Feature";
  properties: {
    autoRatio: number;
  };
  geometry: {
    type: "LineString";
    coordinates: number[][];
  };
}

export default function MapPage() {
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [busData, setBusData] = useState<BusDataRow[]>([]);
  const [segmentInterval, setSegmentInterval] = useState<number>(200);
  const [viewState, setViewState] = useState({
    longitude: 140.5307,
    latitude: 36.5388,
    zoom: 14,
  });

  const availableFiles = ["demo.csv", "demo2.csv", "demo3.csv"];

  const handleFileSelect = useCallback(async (fileName: string) => {
    setSelectedFile(fileName);

    try {
      const response = await fetch(`/data/trips/${fileName}`);
      const csvText = await response.text();

      Papa.parse<BusDataRow>(csvText, {
        header: true,
        complete: (results) => {
          // utc_timeでソート
          const sortedData = results.data
            .filter((row) => row.lat && row.lon)
            .sort(
              (a, b) =>
                new Date(a.utc_time).getTime() - new Date(b.utc_time).getTime(),
            );

          setBusData(sortedData);

          // 最初のポイントにマップを移動
          if (sortedData.length > 0) {
            setViewState({
              longitude: parseFloat(sortedData[0].lon),
              latitude: parseFloat(sortedData[0].lat),
              zoom: 14,
            });
          }
        },
        error: (error: Error) => {
          console.error("CSV parsing error:", error);
        },
      });
    } catch (error) {
      console.error("File loading error:", error);
    }
  }, []);

  // GeoJSON LineStringを生成
  const geojsonData = useMemo(() => {
    if (busData.length === 0) return null;

    const coordinates = busData.map((row) => [
      parseFloat(row.lon),
      parseFloat(row.lat),
    ]);

    const feature: GeoJSONFeature = {
      type: "Feature",
      properties: {
        autoRatio: 0,
      },
      geometry: {
        type: "LineString",
        coordinates,
      },
    };

    return {
      type: "FeatureCollection",
      features: [feature],
    };
  }, [busData]);

  // 区間化とAUTO比率の計算
  const segments = useMemo(() => {
    if (busData.length < 2) return [];

    const result: Segment[] = [];
    let currentDistance = 0;
    let segmentStart = 0;
    let autoDistance = 0;

    for (let i = 1; i < busData.length; i++) {
      const prev = busData[i - 1];
      const curr = busData[i];

      const distance = calculateGeodesicDistance(
        parseFloat(prev.lat),
        parseFloat(prev.lon),
        parseFloat(curr.lat),
        parseFloat(curr.lon)
      );

      // AUTO modeの距離を累積
      if (curr.mode === "AUTO") {
        autoDistance += distance;
      }

      currentDistance += distance;

      // 区間距離に達したらセグメントを作成
      if (currentDistance >= segmentInterval) {
        result.push({
          startIndex: segmentStart,
          endIndex: i,
          distance: currentDistance,
          autoRatio: currentDistance > 0 ? autoDistance / currentDistance : 0,
        });

        // 次のセグメントの準備
        segmentStart = i;
        currentDistance = 0;
        autoDistance = 0;
      }
    }

    // 最後の残りのセグメント
    if (currentDistance > 0 && segmentStart < busData.length - 1) {
      result.push({
        startIndex: segmentStart,
        endIndex: busData.length - 1,
        distance: currentDistance,
        autoRatio: currentDistance > 0 ? autoDistance / currentDistance : 0,
      });
    }

    return result;
  }, [busData, segmentInterval]);

  // ヒートマップ用GeoJSON生成
  const heatmapData = useMemo(() => {
    if (segments.length === 0) return null;

    const features: GeoJSONFeature[] = segments.map((segment) => {
      // セグメント内の全座標点を取得
      const coordinates = [];
      for (let i = segment.startIndex; i <= segment.endIndex; i++) {
        coordinates.push([
          parseFloat(busData[i].lon),
          parseFloat(busData[i].lat),
        ]);
      }

      return {
        type: "Feature" as const,
        properties: {
          autoRatio: segment.autoRatio,
        },
        geometry: {
          type: "LineString" as const,
          coordinates,
        },
      };
    });

    return {
      type: "FeatureCollection" as const,
      features,
    };
  }, [segments, busData]);

  // 統計情報
  const stats = useMemo(() => {
    if (segments.length === 0)
      return { totalDistance: 0, avgAutoRatio: 0, segmentCount: 0 };

    const totalDistance = segments.reduce((sum, seg) => sum + seg.distance, 0);
    const avgAutoRatio =
      segments.reduce((sum, seg) => sum + seg.autoRatio, 0) / segments.length;

    return {
      totalDistance,
      avgAutoRatio,
      segmentCount: segments.length,
    };
  }, [segments]);

  return (
    <div className="flex h-screen">
      {/* 左パネル */}
      <div className="w-64 bg-gray-100 p-4 overflow-y-auto">
        <h2 className="text-lg font-bold mb-4">ファイル選択</h2>
        <ul className="space-y-2">
          {availableFiles.map((file) => (
            <li key={file}>
              <button
                onClick={() => handleFileSelect(file)}
                className={`w-full text-left px-3 py-2 rounded transition-colors ${
                  selectedFile === file
                    ? "bg-blue-500 text-white"
                    : "bg-white hover:bg-gray-200"
                }`}
              >
                {file}
              </button>
            </li>
          ))}
        </ul>

        {/* 区間距離設定 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">区間距離 (m)</h3>
          <input
            type="number"
            value={segmentInterval}
            onChange={(e) => setSegmentInterval(Number(e.target.value))}
            min="50"
            max="1000"
            step="50"
            className="w-full px-2 py-1 border rounded"
          />
        </div>

        {busData.length > 0 && (
          <div className="mt-4 p-3 bg-white rounded">
            <h3 className="font-semibold mb-2">データ情報</h3>
            <p className="text-sm text-gray-600">
              ポイント数: {busData.length}
            </p>
            <p className="text-sm text-gray-600">
              車両ID: {busData[0]?.vehicle_id}
            </p>
            <p className="text-sm text-gray-600">
              路線: {busData[0]?.route_key}
            </p>
          </div>
        )}

        {segments.length > 0 && (
          <div className="mt-4 p-3 bg-white rounded">
            <h3 className="font-semibold mb-2">統計情報</h3>
            <p className="text-sm text-gray-600">
              セグメント数: {stats.segmentCount}
            </p>
            <p className="text-sm text-gray-600">
              総距離: {stats.totalDistance.toFixed(2)} m
            </p>
            <p className="text-sm text-gray-600">
              平均AUTO比率: {(stats.avgAutoRatio * 100).toFixed(1)}%
            </p>
          </div>
        )}

        {/* 凡例 */}
        <div className="mt-4 p-3 bg-white rounded">
          <h3 className="font-semibold mb-2">凡例</h3>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="w-8 h-3 bg-red-600"></div>
              <span className="text-xs">AUTO比率 低</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-3 bg-yellow-400"></div>
              <span className="text-xs">AUTO比率 中</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-3 bg-green-500"></div>
              <span className="text-xs">AUTO比率 高</span>
            </div>
          </div>
        </div>
      </div>

      {/* マップ */}
      <div className="flex-1">
        <Map
          {...viewState}
          onMove={(evt) => setViewState(evt.viewState)}
          style={{ width: "100%", height: "100%" }}
          mapStyle="https://tile.openstreetmap.jp/styles/osm-bright-ja/style.json"
        >
          {heatmapData && (
            <Source id="heatmap-segments" type="geojson" data={heatmapData}>
              <Layer
                id="heatmap-line"
                type="line"
                paint={{
                  "line-color": [
                    "interpolate",
                    ["linear"],
                    ["get", "autoRatio"],
                    0,
                    "#dc2626", // 赤 (AUTO比率低)
                    0.5,
                    "#facc15", // 黄色 (AUTO比率中)
                    1,
                    "#22c55e", // 緑 (AUTO比率高)
                  ],
                  "line-width": 5,
                  "line-opacity": 0.8,
                }}
              />
            </Source>
          )}
        </Map>
      </div>
    </div>
  );
}
