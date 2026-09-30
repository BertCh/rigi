// World Magnetic Model 2025 (NOAA NCEI / BGS; public domain, US Government work): magnetic declination
// for the GEO priors (reports/geometry-first-pose.md G3, GA0 "apply declination when the heading is
// magnetic"). Degree/order 12 spherical-harmonic main field + linear secular variation, valid 2025.0–2030.0
// (outside that window the linear SV is extrapolated; the result degrades by ~0.1°/yr and is still far
// better than none for a compass prior with σ ≈ 10°).
//
// Coefficients: WMM2025.COF (epoch 2025.0, released 11/13/2024), copied verbatim from
// https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip. Rows: n, m, g, h (nT), ġ, ḣ (nT/yr).
// Validated against the official WMM2025_TestValues.txt (100 points, 2025.0–2029.5) in priors.check.ts.
//
// Algorithm (WMM technical report 2025, §1.2): geodetic (WGS84) → geocentric spherical coordinates,
// Schmidt semi-normalised associated Legendre functions (Gauss recursion + Schmidt factors), field in the
// geocentric frame, rotated back to the geodetic frame. Declination D = atan2(Y, X), east positive.

const DEG = Math.PI / 180;
const A_WGS84 = 6378.137; // km
const F_WGS84 = 1 / 298.257223563;
const E2 = F_WGS84 * (2 - F_WGS84);
const RE = 6371.2; // geomagnetic reference radius, km
const EPOCH = 2025.0;
const NMAX = 12;

// biome-ignore format: one COF row (n, m, g, h, ġ, ḣ) per line
const COF: readonly number[] = [
	1, 0, -29351.8, 0.0, 12.0, 0.0,
	1, 1, -1410.8, 4545.4, 9.7, -21.5,
	2, 0, -2556.6, 0.0, -11.6, 0.0,
	2, 1, 2951.1, -3133.6, -5.2, -27.7,
	2, 2, 1649.3, -815.1, -8.0, -12.1,
	3, 0, 1361.0, 0.0, -1.3, 0.0,
	3, 1, -2404.1, -56.6, -4.2, 4.0,
	3, 2, 1243.8, 237.5, 0.4, -0.3,
	3, 3, 453.6, -549.5, -15.6, -4.1,
	4, 0, 895.0, 0.0, -1.6, 0.0,
	4, 1, 799.5, 278.6, -2.4, -1.1,
	4, 2, 55.7, -133.9, -6.0, 4.1,
	4, 3, -281.1, 212.0, 5.6, 1.6,
	4, 4, 12.1, -375.6, -7.0, -4.4,
	5, 0, -233.2, 0.0, 0.6, 0.0,
	5, 1, 368.9, 45.4, 1.4, -0.5,
	5, 2, 187.2, 220.2, 0.0, 2.2,
	5, 3, -138.7, -122.9, 0.6, 0.4,
	5, 4, -142.0, 43.0, 2.2, 1.7,
	5, 5, 20.9, 106.1, 0.9, 1.9,
	6, 0, 64.4, 0.0, -0.2, 0.0,
	6, 1, 63.8, -18.4, -0.4, 0.3,
	6, 2, 76.9, 16.8, 0.9, -1.6,
	6, 3, -115.7, 48.8, 1.2, -0.4,
	6, 4, -40.9, -59.8, -0.9, 0.9,
	6, 5, 14.9, 10.9, 0.3, 0.7,
	6, 6, -60.7, 72.7, 0.9, 0.9,
	7, 0, 79.5, 0.0, -0.0, 0.0,
	7, 1, -77.0, -48.9, -0.1, 0.6,
	7, 2, -8.8, -14.4, -0.1, 0.5,
	7, 3, 59.3, -1.0, 0.5, -0.8,
	7, 4, 15.8, 23.4, -0.1, 0.0,
	7, 5, 2.5, -7.4, -0.8, -1.0,
	7, 6, -11.1, -25.1, -0.8, 0.6,
	7, 7, 14.2, -2.3, 0.8, -0.2,
	8, 0, 23.2, 0.0, -0.1, 0.0,
	8, 1, 10.8, 7.1, 0.2, -0.2,
	8, 2, -17.5, -12.6, 0.0, 0.5,
	8, 3, 2.0, 11.4, 0.5, -0.4,
	8, 4, -21.7, -9.7, -0.1, 0.4,
	8, 5, 16.9, 12.7, 0.3, -0.5,
	8, 6, 15.0, 0.7, 0.2, -0.6,
	8, 7, -16.8, -5.2, -0.0, 0.3,
	8, 8, 0.9, 3.9, 0.2, 0.2,
	9, 0, 4.6, 0.0, -0.0, 0.0,
	9, 1, 7.8, -24.8, -0.1, -0.3,
	9, 2, 3.0, 12.2, 0.1, 0.3,
	9, 3, -0.2, 8.3, 0.3, -0.3,
	9, 4, -2.5, -3.3, -0.3, 0.3,
	9, 5, -13.1, -5.2, 0.0, 0.2,
	9, 6, 2.4, 7.2, 0.3, -0.1,
	9, 7, 8.6, -0.6, -0.1, -0.2,
	9, 8, -8.7, 0.8, 0.1, 0.4,
	9, 9, -12.9, 10.0, -0.1, 0.1,
	10, 0, -1.3, 0.0, 0.1, 0.0,
	10, 1, -6.4, 3.3, 0.0, 0.0,
	10, 2, 0.2, 0.0, 0.1, -0.0,
	10, 3, 2.0, 2.4, 0.1, -0.2,
	10, 4, -1.0, 5.3, -0.0, 0.1,
	10, 5, -0.6, -9.1, -0.3, -0.1,
	10, 6, -0.9, 0.4, 0.0, 0.1,
	10, 7, 1.5, -4.2, -0.1, 0.0,
	10, 8, 0.9, -3.8, -0.1, -0.1,
	10, 9, -2.7, 0.9, -0.0, 0.2,
	10, 10, -3.9, -9.1, -0.0, -0.0,
	11, 0, 2.9, 0.0, 0.0, 0.0,
	11, 1, -1.5, 0.0, -0.0, -0.0,
	11, 2, -2.5, 2.9, 0.0, 0.1,
	11, 3, 2.4, -0.6, 0.0, -0.0,
	11, 4, -0.6, 0.2, 0.0, 0.1,
	11, 5, -0.1, 0.5, -0.1, -0.0,
	11, 6, -0.6, -0.3, 0.0, -0.0,
	11, 7, -0.1, -1.2, -0.0, 0.1,
	11, 8, 1.1, -1.7, -0.1, -0.0,
	11, 9, -1.0, -2.9, -0.1, 0.0,
	11, 10, -0.2, -1.8, -0.1, 0.0,
	11, 11, 2.6, -2.3, -0.1, 0.0,
	12, 0, -2.0, 0.0, 0.0, 0.0,
	12, 1, -0.2, -1.3, 0.0, -0.0,
	12, 2, 0.3, 0.7, -0.0, 0.0,
	12, 3, 1.2, 1.0, -0.0, -0.1,
	12, 4, -1.3, -1.4, -0.0, 0.1,
	12, 5, 0.6, -0.0, -0.0, -0.0,
	12, 6, 0.6, 0.6, 0.1, -0.0,
	12, 7, 0.5, -0.1, -0.0, -0.0,
	12, 8, -0.1, 0.8, 0.0, 0.0,
	12, 9, -0.4, 0.1, 0.0, -0.0,
	12, 10, -0.2, -1.0, -0.1, -0.0,
	12, 11, -1.3, 0.1, -0.0, 0.0,
	12, 12, -0.7, 0.2, -0.1, -0.1,
];

type Coeffs = {
	g: Float64Array;
	h: Float64Array;
	gd: Float64Array;
	hd: Float64Array;
};
const idx = (n: number, m: number) => n * (NMAX + 1) + m;

let coeffs: Coeffs | null = null;
/** Schmidt-normalised coefficients folded into Gauss-normalised ones (S[n][m] factors). */
function load(): Coeffs {
	if (coeffs) return coeffs;
	const L = (NMAX + 1) * (NMAX + 1);
	const c: Coeffs = {
		g: new Float64Array(L),
		h: new Float64Array(L),
		gd: new Float64Array(L),
		hd: new Float64Array(L),
	};
	const S = new Float64Array(L);
	S[0] = 1;
	for (let n = 1; n <= NMAX; n++) {
		S[idx(n, 0)] = (S[idx(n - 1, 0)] * (2 * n - 1)) / n;
		for (let m = 1; m <= n; m++)
			S[idx(n, m)] =
				S[idx(n, m - 1)] *
				Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
	}
	for (let r = 0; r < COF.length; r += 6) {
		const k = idx(COF[r], COF[r + 1]);
		c.g[k] = COF[r + 2] * S[k];
		c.h[k] = COF[r + 3] * S[k];
		c.gd[k] = COF[r + 4] * S[k];
		c.hd[k] = COF[r + 5] * S[k];
	}
	coeffs = c;
	return c;
}

/** Decimal year of a Date (UTC), e.g. 2025-07-02 → 2025.5. */
export function decimalYear(d: Date): number {
	const y = d.getUTCFullYear();
	const t0 = Date.UTC(y, 0, 1);
	const t1 = Date.UTC(y + 1, 0, 1);
	return y + (d.getTime() - t0) / (t1 - t0);
}

export type MagField = {
	/** Declination (deg, east of true north +). */
	decl: number;
	/** Inclination (deg, down +). */
	incl: number;
	/** North, east, down components (nT) and horizontal intensity. */
	X: number;
	Y: number;
	Z: number;
	H: number;
};

/**
 * WMM2025 main field at a geodetic position. lat/lon in degrees (WGS84), altM metres above the
 * ellipsoid (MSL is fine: 50 m changes D by < 0.001°), date a Date or a decimal year.
 */
export function magField(
	lat: number,
	lon: number,
	altM: number,
	date: Date | number,
): MagField {
	const c = load();
	const t = (typeof date === "number" ? date : decimalYear(date)) - EPOCH;
	const hKm = (Number.isFinite(altM) ? altM : 0) / 1000;
	const phi = Math.max(-89.999999, Math.min(89.999999, lat)) * DEG;
	const lam = lon * DEG;
	// geodetic → geocentric spherical
	const sphi = Math.sin(phi);
	const Rc = A_WGS84 / Math.sqrt(1 - E2 * sphi * sphi);
	const p = (Rc + hKm) * Math.cos(phi);
	const z = (Rc * (1 - E2) + hKm) * sphi;
	const r = Math.hypot(p, z);
	const phiC = Math.asin(z / r);
	// colatitude θ: P(cos θ) with cos θ = sin φ', sin θ = cos φ'
	const ct = Math.sin(phiC);
	const st = Math.cos(phiC);
	const L = (NMAX + 1) * (NMAX + 1);
	const P = new Float64Array(L);
	const dP = new Float64Array(L);
	P[0] = 1;
	for (let n = 1; n <= NMAX; n++)
		for (let m = 0; m <= n; m++) {
			const k = idx(n, m);
			if (n === m) {
				const k1 = idx(n - 1, m - 1);
				P[k] = st * P[k1];
				dP[k] = st * dP[k1] + ct * P[k1];
			} else if (n === 1) {
				P[k] = ct * P[0];
				dP[k] = ct * dP[0] - st * P[0];
			} else {
				const K = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
				const k1 = idx(n - 1, m);
				const k2 = m <= n - 2 ? idx(n - 2, m) : -1;
				const p2 = k2 >= 0 ? P[k2] : 0;
				const dp2 = k2 >= 0 ? dP[k2] : 0;
				P[k] = ct * P[k1] - K * p2;
				dP[k] = ct * dP[k1] - st * P[k1] - K * dp2;
			}
		}
	let Xc = 0;
	let Yc = 0;
	let Zc = 0;
	const ar = RE / r;
	let arn = ar * ar; // (a/r)^(n+2) at n = 0
	for (let n = 1; n <= NMAX; n++) {
		arn *= ar;
		for (let m = 0; m <= n; m++) {
			const k = idx(n, m);
			const g = c.g[k] + t * c.gd[k];
			const h = c.h[k] + t * c.hd[k];
			const cm = Math.cos(m * lam);
			const sm = Math.sin(m * lam);
			const gh = g * cm + h * sm;
			Xc += arn * gh * dP[k];
			Yc += arn * m * (g * sm - h * cm) * P[k];
			Zc -= arn * (n + 1) * gh * P[k];
		}
	}
	Yc /= st;
	// geocentric → geodetic frame
	const psi = phiC - phi;
	const X = Xc * Math.cos(psi) - Zc * Math.sin(psi);
	const Z = Xc * Math.sin(psi) + Zc * Math.cos(psi);
	const Y = Yc;
	const H = Math.hypot(X, Y);
	return {
		decl: Math.atan2(Y, X) / DEG,
		incl: Math.atan2(Z, H) / DEG,
		X,
		Y,
		Z,
		H,
	};
}

/** Magnetic declination (deg, east +): true heading = magnetic heading + declination. */
export function declination(
	lat: number,
	lon: number,
	altM: number,
	date: Date | number,
): number {
	return magField(lat, lon, altM, date).decl;
}
