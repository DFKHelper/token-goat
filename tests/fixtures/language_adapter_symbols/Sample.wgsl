// CAPTURE: WebGPU Samples shadowMapping fragment.wgsl, https://raw.githubusercontent.com/webgpu/webgpu-samples/main/sample/shadowMapping/fragment.wgsl
override shadowDepthTextureSize: f32 = 1024.0;

struct Scene {
  lightViewProjMatrix : mat4x4f,
  cameraViewProjMatrix : mat4x4f,
  lightPos : vec3f,
}

@group(0) @binding(0) var<uniform> scene : Scene;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;

struct FragmentInput {
  @location(0) shadowPos : vec3f,
  @location(1) fragPos : vec3f,
  @location(2) fragNorm : vec3f,
}

const albedo = vec3f(0.9);
const ambientFactor = 0.2;

@fragment
fn main(input : FragmentInput) -> @location(0) vec4f {
  // Percentage-closer filtering. Sample texels in the region
  // to smooth the result.
  var visibility = 0.0;
  let oneOverShadowDepthTextureSize = 1.0 / shadowDepthTextureSize;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(vec2(x, y)) * oneOverShadowDepthTextureSize;

      visibility += textureSampleCompare(
        shadowMap, shadowSampler,
        input.shadowPos.xy + offset, input.shadowPos.z - 0.007
      );
    }
  }
  visibility /= 9.0;

  let lambertFactor = max(dot(normalize(scene.lightPos - input.fragPos), normalize(input.fragNorm)), 0.0);
  let lightingFactor = min(ambientFactor + visibility * lambertFactor, 1.0);

  return vec4(lightingFactor * albedo, 1.0);
}
//
// This excerpt is redistributed under its original license, reproduced in full below.
//
// Copyright 2019 WebGPU Samples Contributors
// Licensed under the BSD 3-Clause License.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
//
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// 3. Neither the name of the copyright holder nor the names of its contributors
//    may be used to endorse or promote products derived from this software
//    without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
// FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
