'use server';

import fs from 'fs';
import path from 'path';

interface TripFile {
    filename: string;
    displayName: string;
    routeKey: number;
    fullDate: string;
}

/**
 * public/data/trips/以下のCSVファイルをスキャンしてトリップファイル情報を取得
 */
export async function getTripFiles(): Promise<TripFile[]> {
    const tripsDir = path.join(process.cwd(), 'public', 'data', 'trips');

    try {
        const files = fs.readdirSync(tripsDir);
        const csvFiles = files.filter(file => file.endsWith('.csv'));

        const tripFiles: TripFile[] = [];

        for (const filename of csvFiles) {
            const filePath = path.join(tripsDir, filename);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.trim().split('\n');

            if (lines.length < 2) continue;

            // 2行目のデータからroute_keyとfull_dateを取得
            const values = lines[1].split(',');
            if (values.length < 4) continue;

            const routeKey = parseInt(values[3]) || 0;
            const fullDate = values[1] || ''; // full_dateを取得

            // trip_keyからdisplayNameを生成
            const tripKey = values[2] || '';
            let displayName = filename.replace('.csv', '');

            // route_keyに基づいて方向を決定
            const direction = routeKey === 10 ? '北回り' : routeKey === 11 ? '南回り' : '不明';

            // full_dateから日付を整形（例：2026-02-02 -> 02/02）
            let dateStr = '';
            if (fullDate) {
                const dateMatch = fullDate.match(/(\d{4})-(\d{2})-(\d{2})/);
                if (dateMatch) {
                    dateStr = `${dateMatch[2]}/${dateMatch[3]} `;
                }
            }

            // trip_keyから時刻を抽出（例：1全日_14時00分_系統101002 -> 14:00）
            const timeMatch = tripKey.match(/(\d+)時(\d+)分/);
            if (timeMatch) {
                const hour = timeMatch[1];
                const minute = timeMatch[2];
                displayName = `${direction} - ${dateStr}${hour}:${minute}発`;
            } else {
                displayName = `${direction} - ${dateStr}${displayName}`;
            }

            tripFiles.push({
                filename,
                displayName,
                routeKey,
                fullDate,
            });
        }

        // route_keyでソート（北回りが先、南回りが後）
        tripFiles.sort((a, b) => a.routeKey - b.routeKey);

        return tripFiles;
    } catch (error) {
        console.error('トリップファイルの読み込みエラー:', error);
        return [];
    }
}
