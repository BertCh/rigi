// Dev tool: assemble a WGSL program the way luma's Model does (no GPU) and print its binding
// layout — for "bind group entries don't match" errors.  npx tsx scripts/deck-webgpu/wgsl-layout.ts
import { ShaderAssembler } from "@luma.gl/shadertools";
import { getShaderLayoutFromWGSL } from "@luma.gl/webgpu";
import {
	cameraModule,
	photoCameraModule,
} from "../../src/lib/deck-webgpu/camera";
import { fogModule } from "../../src/lib/deck-webgpu/wgsl";

const source = `
@group(0) @binding(auto) var tex: texture_2d<f32>;
@vertex fn vertexMain() -> @builtin(position) vec4<f32> { return camera_clip(vec3<f32>(0.0)); }
@fragment fn fragmentMain() -> @location(0) vec4<f32> {
  let p = photo_uv(vec3<f32>(1.0));
  return vec4<f32>(fog_apply(p, 1.0), textureLoad(tex, vec2<i32>(0), 0).x);
}`;
const asm = ShaderAssembler.getDefaultShaderAssembler(
	"wgsl" as never,
) as never as {
	assembleWGSLShader(p: unknown): {
		source: string;
		shaderLayout?: unknown;
		bindingTable: unknown;
	};
};
const r = asm.assembleWGSLShader({
	platformInfo: {
		type: "webgpu",
		shaderLanguage: "wgsl",
		shaderLanguageVersion: 100,
		gpu: "apple",
		features: new Set(),
	},
	source,
	modules: [cameraModule, fogModule, photoCameraModule],
	defines: {},
});
console.log(
	r.source
		.split("\n")
		.filter((l) => /@binding|var<uniform>|struct CameraUniforms/.test(l))
		.join("\n"),
);
console.log(
	JSON.stringify(
		r.shaderLayout ?? getShaderLayoutFromWGSL(r.source),
		null,
		0,
	).slice(0, 2000),
);
