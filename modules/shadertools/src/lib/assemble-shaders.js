import {VERTEX_SHADER, FRAGMENT_SHADER} from './constants';
import {resolveModules, getShaderModule} from './resolve-modules';
import {getPlatformShaderDefines, getVersionDefines} from './platform-defines';
import injectShader from './inject-shader';
import {assert} from '../utils';
/* eslint-disable max-depth */

const SHADER_TYPE = {
  [VERTEX_SHADER]: 'vertex',
  [FRAGMENT_SHADER]: 'fragment'
};

const HOOK_FUNCTIONS = {
  [VERTEX_SHADER]: {},
  [FRAGMENT_SHADER]: {}
};

const MODULE_INJECTIONS = {};

// Precision prologue to inject before functions are injected in shader
// TODO - extract any existing prologue in the fragment source and move it up...
const FRAGMENT_SHADER_PROLOGUE = `\
precision highp float;

`;

export function setShaderHook(type, opts) {
  const name = opts.signature.trim().replace(/\(.+/, '');
  HOOK_FUNCTIONS[type][name] = opts;
}

export function setModuleInjection(moduleName, opts) {
  const {shaderStage, shaderHook, injection, order = 0} = opts;

  MODULE_INJECTIONS[moduleName] = MODULE_INJECTIONS[moduleName] || {};
  MODULE_INJECTIONS[moduleName][shaderStage] = MODULE_INJECTIONS[moduleName][shaderStage] || {};

  assert(!MODULE_INJECTIONS[moduleName][shaderStage][shaderHook], 'Module injection already set');

  MODULE_INJECTIONS[moduleName][shaderStage][shaderHook] = {
    injection,
    order
  };
}

// Inject a list of modules
export function assembleShaders(gl, opts = {}) {
  const {vs, fs} = opts;
  const modules = resolveModules(opts.modules || []);
  return {
    gl,
    vs: assembleShader(gl, Object.assign({}, opts, {source: vs, type: VERTEX_SHADER, modules})),
    fs: assembleShader(gl, Object.assign({}, opts, {source: fs, type: FRAGMENT_SHADER, modules})),
    getUniforms: assembleGetUniforms(modules),
    modules: assembleModuleMap(modules)
  };
}

// Pulls together complete source code for either a vertex or a fragment shader
// adding prologues, requested module chunks, and any final injections.
function assembleShader(
  gl,
  {id, source, type, modules = [], defines = {}, inject = {}, prologue = true, log}
) {
  assert(typeof source === 'string', 'shader source must be a string');

  const isVertex = type === VERTEX_SHADER;

  const sourceLines = source.split('\n');
  let glslVersion = 100;
  let versionLine = '';
  let coreSource = source;
  // Extract any version directive string from source.
  // TODO : keep all pre-processor statements at the begining of the shader.
  if (sourceLines[0].indexOf('#version ') === 0) {
    glslVersion = 300; // TODO - regexp that matches atual version number
    versionLine = sourceLines[0];
    coreSource = sourceLines.slice(1).join('\n');
  }

  // Combine Module and Application Defines
  const allDefines = {};
  modules.forEach(module => {
    Object.assign(allDefines, module.getDefines());
  });
  Object.assign(allDefines, defines);

  // Add platform defines (use these to work around platform-specific bugs and limitations)
  // Add common defines (GLSL version compatibility, feature detection)
  // Add precision declaration for fragment shaders
  let assembledSource = prologue
    ? `\
${versionLine}
${getShaderName({id, source, type})}
${getShaderType({type})}
${getPlatformShaderDefines(gl)}
${getVersionDefines(gl, glslVersion, !isVertex)}
${getApplicationDefines(allDefines)}
${isVertex ? '' : FRAGMENT_SHADER_PROLOGUE}
`
    : `${versionLine}
`;

  // Add source of dependent modules in resolved order
  let injectStandardStubs = false;
  const moduleInjections = {};
  for (const module of modules) {
    switch (module.name) {
      case 'inject':
        injectStandardStubs = true;
        break;

      default:
        module.checkDeprecations(coreSource, log);
        const moduleSource = module.getModuleSource(type, glslVersion);
        // Add the module source, and a #define that declares it presence
        assembledSource += moduleSource;

        if (MODULE_INJECTIONS[module.name]) {
          const injections = MODULE_INJECTIONS[module.name][type];
          for (const key in injections) {
            moduleInjections[key] = moduleInjections[key] || [];
            moduleInjections[key].push(injections[key]);
          }
        }
    }
  }

  assembledSource += getHookFunctions(type, moduleInjections);

  // Add the version directive and actual source of this shader
  assembledSource += coreSource;

  // Apply any requested shader injections
  assembledSource = injectShader(assembledSource, type, inject, injectStandardStubs);

  return assembledSource;
}

// Returns a combined `getUniforms` covering the options for all the modules,
// the created function will pass on options to the inidividual `getUniforms`
// function of each shader module and combine the results into one object that
// can be passed to setUniforms.
function assembleGetUniforms(modules) {
  return function getUniforms(opts) {
    const uniforms = {};
    for (const module of modules) {
      // `modules` is already sorted by dependency level. This guarantees that
      // modules have access to the uniforms that are generated by their dependencies.
      const moduleUniforms = module.getUniforms(opts, uniforms);
      Object.assign(uniforms, moduleUniforms);
    }
    return uniforms;
  };
}

// Returns a map with module names as keys, resolving to their module definitions
// The presence of a key indicates that the module is available in this program,
// whether directly included, or through a dependency of some other module
function assembleModuleMap(modules) {
  const result = {};
  for (const moduleName of modules) {
    const shaderModule = getShaderModule(moduleName);
    result[moduleName] = shaderModule;
  }
  return result;
}

function getShaderType({type}) {
  return `
#define SHADER_TYPE_${SHADER_TYPE[type].toUpperCase()}
`;
}

// Generate "glslify-compatible" SHADER_NAME defines
// These are understood by the GLSL error parsing function
// If id is provided and no SHADER_NAME constant is present in source, create one
function getShaderName({id, source, type}) {
  const injectShaderName = id && typeof id === 'string' && source.indexOf('SHADER_NAME') === -1;
  return injectShaderName
    ? `
#define SHADER_NAME ${id}_${SHADER_TYPE[type]}

`
    : '';
}

// Generates application defines from an object
function getApplicationDefines(defines = {}) {
  let count = 0;
  let sourceText = '';
  for (const define in defines) {
    if (count === 0) {
      sourceText += '\n// APPLICATION DEFINES\n';
    }
    count++;

    const value = defines[define];
    if (value || Number.isFinite(value)) {
      sourceText += `#define ${define.toUpperCase()} ${defines[define]}\n`;
    }
  }
  if (count === 0) {
    sourceText += '\n';
  }
  return sourceText;
}

function getHookFunctions(shaderType, moduleInjections) {
  let result = '';
  const hookFunctions = HOOK_FUNCTIONS[shaderType];
  for (const hookName in hookFunctions) {
    const hookFunction = hookFunctions[hookName];
    result += `void ${hookFunction.signature} {\n`;
    if (hookFunction.header) {
      result += `  ${hookFunction.header}`;
    }
    if (moduleInjections[hookName]) {
      const injections = moduleInjections[hookName];
      injections.sort((a, b) => a.order - b.order);
      for (const injection of injections) {
        result += `  ${injection.injection};\n`;
      }
    }
    if (hookFunction.footer) {
      result += `  ${hookFunction.footer}`;
    }
    result += '}\n';
  }

  return result;
}
