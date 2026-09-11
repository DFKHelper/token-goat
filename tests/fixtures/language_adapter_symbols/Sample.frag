// FORMAT-DERIVED: OpenGL Shading Language 3.30 specification, https://registry.khronos.org/OpenGL/specs/gl/GLSLangSpec.3.30.pdf : section 4.1.8 (structures), section 4.3 (in, out and uniform storage qualifiers), section 6.1 (function definitions and prototypes), section 8 (built-in functions used below).
#version 330 core
out vec4 FragColor;

struct SurfaceProps {
    sampler2D baseMap;
    sampler2D glossMap;
    float glossPower;
};

struct BeamSource {
    vec3 aim;
    vec3 ambientTint;
    vec3 diffuseTint;
    vec3 glossTint;
};

struct GlowSource {
    vec3 spot;
    float falloffConst;
    float falloffLinear;
    float falloffSquare;
    vec3 ambientTint;
    vec3 diffuseTint;
    vec3 glossTint;
};

struct ConeSource {
    vec3 spot;
    vec3 aim;
    float innerCos;
    float outerCos;
    float falloffConst;
    float falloffLinear;
    float falloffSquare;
    vec3 ambientTint;
    vec3 diffuseTint;
    vec3 glossTint;
};

#define GLOW_COUNT 4

in vec3 SurfacePos;
in vec3 SurfaceNormal;
in vec2 SurfaceUV;

uniform vec3 eyePos;
uniform BeamSource beam;
uniform GlowSource glows[GLOW_COUNT];
uniform ConeSource cone;
uniform SurfaceProps surface;

// function prototypes
vec3 ShadeBeam(BeamSource src, vec3 nrm, vec3 eyeDir);
vec3 ShadeGlow(GlowSource src, vec3 nrm, vec3 pos, vec3 eyeDir);
vec3 ShadeCone(ConeSource src, vec3 nrm, vec3 pos, vec3 eyeDir);

void main()
{
    vec3 nrm = normalize(SurfaceNormal);
    vec3 eyeDir = normalize(eyePos - SurfacePos);

    vec3 total = ShadeBeam(beam, nrm, eyeDir);
    for (int i = 0; i < GLOW_COUNT; i++)
        total += ShadeGlow(glows[i], nrm, SurfacePos, eyeDir);
    total += ShadeCone(cone, nrm, SurfacePos, eyeDir);

    FragColor = vec4(total, 1.0);
}

// A directional source: one aim vector for the whole surface, so there is no falloff term.
vec3 ShadeBeam(BeamSource src, vec3 nrm, vec3 eyeDir)
{
    vec3 rayDir = normalize(-src.aim);
    float lambert = max(dot(nrm, rayDir), 0.0);
    vec3 mirrorDir = reflect(-rayDir, nrm);
    float gloss = pow(max(dot(eyeDir, mirrorDir), 0.0), surface.glossPower);
    vec3 ambient = src.ambientTint * vec3(texture(surface.baseMap, SurfaceUV));
    vec3 diffuse = src.diffuseTint * lambert * vec3(texture(surface.baseMap, SurfaceUV));
    vec3 specular = src.glossTint * gloss * vec3(texture(surface.glossMap, SurfaceUV));
    return ambient + diffuse + specular;
}

// A positional source: the same shading, scaled by how far the sample sits from it.
vec3 ShadeGlow(GlowSource src, vec3 nrm, vec3 pos, vec3 eyeDir)
{
    vec3 rayDir = normalize(src.spot - pos);
    float lambert = max(dot(nrm, rayDir), 0.0);
    vec3 mirrorDir = reflect(-rayDir, nrm);
    float gloss = pow(max(dot(eyeDir, mirrorDir), 0.0), surface.glossPower);
    float dist = length(src.spot - pos);
    float drop = 1.0 / (src.falloffConst + src.falloffLinear * dist + src.falloffSquare * (dist * dist));
    vec3 ambient = src.ambientTint * vec3(texture(surface.baseMap, SurfaceUV));
    vec3 diffuse = src.diffuseTint * lambert * vec3(texture(surface.baseMap, SurfaceUV));
    vec3 specular = src.glossTint * gloss * vec3(texture(surface.glossMap, SurfaceUV));
    return (ambient + diffuse + specular) * drop;
}

// A positional source clipped to a cone, with the rim faded between the two cosines.
vec3 ShadeCone(ConeSource src, vec3 nrm, vec3 pos, vec3 eyeDir)
{
    vec3 rayDir = normalize(src.spot - pos);
    float lambert = max(dot(nrm, rayDir), 0.0);
    vec3 mirrorDir = reflect(-rayDir, nrm);
    float gloss = pow(max(dot(eyeDir, mirrorDir), 0.0), surface.glossPower);
    float dist = length(src.spot - pos);
    float drop = 1.0 / (src.falloffConst + src.falloffLinear * dist + src.falloffSquare * (dist * dist));
    float theta = dot(rayDir, normalize(-src.aim));
    float band = src.innerCos - src.outerCos;
    float edge = clamp((theta - src.outerCos) / band, 0.0, 1.0);
    vec3 ambient = src.ambientTint * vec3(texture(surface.baseMap, SurfaceUV));
    vec3 diffuse = src.diffuseTint * lambert * vec3(texture(surface.baseMap, SurfaceUV));
    vec3 specular = src.glossTint * gloss * vec3(texture(surface.glossMap, SurfaceUV));
    return (ambient + diffuse + specular) * drop * edge;
}
