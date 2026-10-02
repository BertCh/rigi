// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Reference real 2-D FFTs (torch.fft.rfft2 / irfft2, norm "backward") as plain O(N²) DFTs in f64, for
// specs and the Dawn parity of the GPU rfft2 / irfft2. Complex data is interleaved (re, im), like
// torch.view_as_real: rfft2 gives [batch, H, W/2+1, 2]; irfft2 takes that and gives [batch, H, W].
// Independent of the GPU kernels: irfft2 follows torch's definition (inverse complex FFT along H,
// then a complex-to-real transform per row that drops the imaginary part of the DC and Nyquist bins).

export function rfft2Reference(
	x: Float32Array,
	batch: number,
	height: number,
	width: number,
): Float32Array {
	const wf = (width >> 1) + 1;
	const out = new Float32Array(batch * height * wf * 2);
	const cw = Float64Array.from({ length: width }, (_, k) =>
		Math.cos((2 * Math.PI * k) / width),
	);
	const sw = Float64Array.from({ length: width }, (_, k) =>
		Math.sin((2 * Math.PI * k) / width),
	);
	const ch = Float64Array.from({ length: height }, (_, k) =>
		Math.cos((2 * Math.PI * k) / height),
	);
	const sh = Float64Array.from({ length: height }, (_, k) =>
		Math.sin((2 * Math.PI * k) / height),
	);
	for (let b = 0; b < batch; b++) {
		// rows: real DFT along W (bins 0..W/2)
		const rowRe = new Float64Array(height * wf);
		const rowIm = new Float64Array(height * wf);
		for (let h = 0; h < height; h++)
			for (let u = 0; u < wf; u++) {
				let re = 0;
				let im = 0;
				for (let w = 0; w < width; w++) {
					const v = x[(b * height + h) * width + w];
					const k = (u * w) % width;
					re += v * cw[k];
					im -= v * sw[k];
				}
				rowRe[h * wf + u] = re;
				rowIm[h * wf + u] = im;
			}
		// columns: complex DFT along H
		for (let v = 0; v < height; v++)
			for (let u = 0; u < wf; u++) {
				let re = 0;
				let im = 0;
				for (let h = 0; h < height; h++) {
					const k = (v * h) % height;
					const a = rowRe[h * wf + u];
					const c = rowIm[h * wf + u];
					re += a * ch[k] + c * sh[k];
					im += c * ch[k] - a * sh[k];
				}
				const o = ((b * height + v) * wf + u) * 2;
				out[o] = re;
				out[o + 1] = im;
			}
	}
	return out;
}

export function irfft2Reference(
	spectrum: Float32Array,
	batch: number,
	height: number,
	width: number,
): Float32Array {
	const wf = (width >> 1) + 1;
	const out = new Float32Array(batch * height * width);
	for (let b = 0; b < batch; b++) {
		// inverse complex DFT along H for each kept column
		const yRe = new Float64Array(height * wf);
		const yIm = new Float64Array(height * wf);
		for (let h = 0; h < height; h++)
			for (let u = 0; u < wf; u++) {
				let re = 0;
				let im = 0;
				for (let v = 0; v < height; v++) {
					const k = (v * h) % height;
					const t = (2 * Math.PI * k) / height;
					const a = spectrum[((b * height + v) * wf + u) * 2];
					const c = spectrum[((b * height + v) * wf + u) * 2 + 1];
					re += a * Math.cos(t) - c * Math.sin(t);
					im += a * Math.sin(t) + c * Math.cos(t);
				}
				yRe[h * wf + u] = re;
				yIm[h * wf + u] = im;
			}
		// per row: complex-to-real along W; DC / Nyquist imaginary parts do not contribute
		for (let h = 0; h < height; h++)
			for (let w = 0; w < width; w++) {
				let s = yRe[h * wf];
				for (let u = 1; u < wf; u++) {
					const t = (2 * Math.PI * ((u * w) % width)) / width;
					const nyquist = width % 2 === 0 && u === width / 2;
					const re = yRe[h * wf + u];
					const im = yIm[h * wf + u];
					s +=
						(nyquist ? 1 : 2) *
						(nyquist ? re * Math.cos(t) : re * Math.cos(t) - im * Math.sin(t));
				}
				out[(b * height + h) * width + w] = s / (height * width);
			}
	}
	return out;
}
