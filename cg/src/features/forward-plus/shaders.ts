export const forwardPlusVertexShader = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vUv;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPos.xyz;
  // 与 MeshDepthMaterial 一致：使用 modelViewMatrix，避免 Depth Prepass 深度打架
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const forwardPlusFragmentShader = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform vec3 uColor;
uniform sampler2D uMap;
uniform float uHasMap;
uniform float uMetalness;
uniform float uRoughness;

uniform sampler2D uLights;
uniform sampler2D uTileCounts;
uniform sampler2D uTileIndices;
uniform vec2 uTileCount;
uniform float uTileSize;
uniform float uMaxLightsPerTile;
uniform float uLightCount;
uniform vec3 uCameraPos;
uniform float uShowHeatmap;
uniform float uHeatmapScale;

varying vec3 vWorldPosition;
varying vec3 vWorldNormal;
varying vec2 vUv;

vec4 fetchLightPosRadius(float index) {
  float v = (index + 0.5) / max(uLightCount, 1.0);
  return texture2D(uLights, vec2(0.25, v));
}

vec3 fetchLightColor(float index) {
  float v = (index + 0.5) / max(uLightCount, 1.0);
  return texture2D(uLights, vec2(0.75, v)).xyz;
}

vec3 heatmapColor(float t) {
  float x = clamp(t, 0.0, 1.0);
  return mix(
    mix(vec3(0.1, 0.25, 0.95), vec3(0.1, 0.9, 0.25), smoothstep(0.0, 0.5, x)),
    vec3(0.95, 0.15, 0.1),
    smoothstep(0.5, 1.0, x)
  );
}

float attenuate(float dist, float radius) {
  float x = clamp(1.0 - dist / radius, 0.0, 1.0);
  return x * x;
}

void main() {
  vec3 albedo = uColor;
  if (uHasMap > 0.5) {
    albedo *= texture2D(uMap, vUv).rgb;
  }

  vec2 tileCoord = floor(gl_FragCoord.xy / uTileSize);
  tileCoord = clamp(tileCoord, vec2(0.0), uTileCount - 1.0);
  float tileIndex = tileCoord.y * uTileCount.x + tileCoord.x;

  float count = texture2D(uTileCounts, (tileCoord + 0.5) / uTileCount).r;

  if (uShowHeatmap > 0.5) {
    gl_FragColor = vec4(heatmapColor(count / max(uHeatmapScale, 1.0)), 1.0);
    return;
  }

  vec3 N = normalize(vWorldNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCameraPos - vWorldPosition);
  vec3 color = albedo * 0.08;

  for (int i = 0; i < 128; i++) {
    if (float(i) >= count) break;

    float lightIndex = texture2D(
      uTileIndices,
      vec2(
        (float(i) + 0.5) / uMaxLightsPerTile,
        (tileIndex + 0.5) / (uTileCount.x * uTileCount.y)
      )
    ).r;

    vec4 posR = fetchLightPosRadius(lightIndex);
    vec3 Lpos = posR.xyz;
    float radius = max(posR.w, 0.01);
    vec3 Lcol = fetchLightColor(lightIndex);

    vec3 Lvec = Lpos - vWorldPosition;
    float dist = length(Lvec);
    if (dist > radius || dist < 1e-4) continue;

    vec3 L = Lvec / dist;
    float ndotl = max(dot(N, L), 0.0);
    float attenuation = attenuate(dist, radius);

    vec3 H = normalize(V + L);
    float specPower = mix(64.0, 8.0, clamp(uRoughness, 0.0, 1.0));
    float spec = pow(max(dot(N, H), 0.0), specPower);
    if (ndotl <= 0.0) spec = 0.0;

    vec3 diffuse = albedo * (1.0 - uMetalness) * ndotl;
    vec3 specular = mix(vec3(0.04), albedo, uMetalness) * spec;
    color += (diffuse + specular) * Lcol * attenuation;
  }

  color = color / (color + vec3(1.0));
  color = pow(color, vec3(1.0 / 2.2));
  gl_FragColor = vec4(color, 1.0);
}
`;
