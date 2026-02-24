/**
 * Karney法による測地線距離計算
 * WGS84楕円体を使用した高精度な距離計算
 */

const WGS84_A = 6378137.0; // 長半径 (m)
const WGS84_F = 1 / 298.257223563; // 扁平率

/**
 * 2点間の測地線距離を計算 (Karney's algorithm)
 * @param lat1 緯度1 (度)
 * @param lon1 経度1 (度)
 * @param lat2 緯度2 (度)
 * @param lon2 経度2 (度)
 * @returns 距離 (メートル)
 */
export function calculateGeodesicDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  // 度をラジアンに変換
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const lambda1 = toRad(lon1);
  const lambda2 = toRad(lon2);

  const b = WGS84_A * (1 - WGS84_F); // 短半径
  const f = WGS84_F;

  const L = lambda2 - lambda1;
  const U1 = Math.atan((1 - f) * Math.tan(phi1));
  const U2 = Math.atan((1 - f) * Math.tan(phi2));

  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let lambdaP;
  let iterLimit = 100;
  let cosSqAlpha, sinSigma, cos2SigmaM, cosSigma, sigma;

  do {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);

    sinSigma = Math.sqrt(
      Math.pow(cosU2 * sinLambda, 2) +
      Math.pow(cosU1 * sinU2 - sinU1 * cosU2 * cosLambda, 2)
    );

    if (sinSigma === 0) return 0; // 同一地点

    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);

    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;

    cos2SigmaM = cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    if (isNaN(cos2SigmaM)) cos2SigmaM = 0; // 赤道上の点

    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));

    lambdaP = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (
      sigma + C * sinSigma * (
        cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
      )
    );
  } while (Math.abs(lambda - lambdaP) > 1e-12 && --iterLimit > 0);

  if (iterLimit === 0) return NaN; // 収束しない

  const uSq = cosSqAlpha * (WGS84_A * WGS84_A - b * b) / (b * b);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));

  const deltaSigma = B * sinSigma * (
    cos2SigmaM + (B / 4) * (
      cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
      (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) *
      (-3 + 4 * cos2SigmaM * cos2SigmaM)
    )
  );

  const distance = b * A * (sigma - deltaSigma);

  return distance;
}
