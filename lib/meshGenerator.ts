/**
 * LineString座標から正方形メッシュを生成するユーティリティ
 */

interface MeshData {
    positions: Float32Array;
    indices: Uint32Array;
    normals: Float32Array;
}

/**
 * 2点間のベクトルに垂直なベクトルを計算
 */
function getPerpendicularVector(
    lon1: number,
    lat1: number,
    lon2: number,
    lat2: number,
    width: number
): { dLon: number; dLat: number } {
    const dx = lon2 - lon1;
    const dy = lat2 - lat1;
    const length = Math.sqrt(dx * dx + dy * dy);

    if (length === 0) {
        return { dLon: 0, dLat: width };
    }

    // 垂直ベクトル（90度回転）
    const perpDx = -dy / length;
    const perpDy = dx / length;

    return {
        dLon: perpDx * width,
        dLat: perpDy * width,
    };
}

/**
 * LineStringの各セグメントに沿って正方形の押し出しメッシュを生成
 * @param coordinates GeoJSON LineString coordinates [[lon, lat], ...]
 * @param width 道路の幅（度単位）
 * @param height 押し出しの高さ（メートル）
 * @param elevation 地面からの高さ（メートル）
 */
export function generateRoadMesh(
    coordinates: number[][],
    width: number = 0.00005, // 約5m
    height: number = 50, // 押し出しの高さ
    elevation: number = 80 // 地面からの高さ
): MeshData {
    const segments = coordinates.length - 1;
    if (segments < 1) {
        return {
            positions: new Float32Array(0),
            indices: new Uint32Array(0),
            normals: new Float32Array(0),
        };
    }

    // 各セグメントに対して正方形のボックスを作成
    // 各セグメント: 8頂点（4つの角 × 上下2層）、12三角形（6面 × 2三角形）
    const verticesPerSegment = 8;
    const trianglesPerSegment = 12;

    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];

    for (let i = 0; i < segments; i++) {
        const [lon1, lat1] = coordinates[i];
        const [lon2, lat2] = coordinates[i + 1];

        // セグメントに垂直な方向のオフセットを計算
        const perp = getPerpendicularVector(lon1, lat1, lon2, lat2, width / 2);

        const baseVertexIndex = i * verticesPerSegment;

        // 下層の4頂点（elevation高度）
        const bottomHeight = elevation;
        positions.push(
            lon1 - perp.dLon, lat1 - perp.dLat, bottomHeight, // 0: 始点左
            lon1 + perp.dLon, lat1 + perp.dLat, bottomHeight, // 1: 始点右
            lon2 + perp.dLon, lat2 + perp.dLat, bottomHeight, // 2: 終点右
            lon2 - perp.dLon, lat2 - perp.dLat, bottomHeight  // 3: 終点左
        );

        // 上層の4頂点（elevation + height高度）
        const topHeight = elevation + height;
        positions.push(
            lon1 - perp.dLon, lat1 - perp.dLat, topHeight, // 4: 始点左上
            lon1 + perp.dLon, lat1 + perp.dLat, topHeight, // 5: 始点右上
            lon2 + perp.dLon, lat2 + perp.dLat, topHeight, // 6: 終点右上
            lon2 - perp.dLon, lat2 - perp.dLat, topHeight  // 7: 終点左上
        );

        // 法線ベクトル（各頂点に対して）
        // 簡易的に全て上向きに設定（より正確には各面ごとに計算）
        for (let j = 0; j < 8; j++) {
            normals.push(0, 0, 1);
        }

        // インデックス（12三角形 = 6面 × 2三角形/面）
        const v = baseVertexIndex;

        // 底面（下向き）
        indices.push(v + 0, v + 2, v + 1, v + 0, v + 3, v + 2);

        // 天面（上向き）
        indices.push(v + 4, v + 5, v + 6, v + 4, v + 6, v + 7);

        // 側面1（左側）
        indices.push(v + 0, v + 4, v + 7, v + 0, v + 7, v + 3);

        // 側面2（右側）
        indices.push(v + 1, v + 2, v + 6, v + 1, v + 6, v + 5);

        // 側面3（始点側）- セグメント間で共有されるため最初だけ
        if (i === 0) {
            indices.push(v + 0, v + 1, v + 5, v + 0, v + 5, v + 4);
        }

        // 側面4（終点側）- 最後のセグメントでのみ
        if (i === segments - 1) {
            indices.push(v + 3, v + 7, v + 6, v + 3, v + 6, v + 2);
        }
    }

    return {
        positions: new Float32Array(positions),
        indices: new Uint32Array(indices),
        normals: new Float32Array(normals),
    };
}
