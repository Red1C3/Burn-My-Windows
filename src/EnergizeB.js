//////////////////////////////////////////////////////////////////////////////////////////
//          )                                                   (                       //
//       ( /(   (  (               )    (       (  (  (         )\ )    (  (            //
//       )\()) ))\ )(   (         (     )\ )    )\))( )\  (    (()/( (  )\))(  (        //
//      ((_)\ /((_|()\  )\ )      )\  '(()/(   ((_)()((_) )\ )  ((_)))\((_)()\ )\       //
//      | |(_|_))( ((_)_(_/(    _((_))  )(_))  _(()((_|_)_(_/(  _| |((_)(()((_|(_)      //
//      | '_ \ || | '_| ' \))  | '  \()| || |  \ V  V / | ' \)) _` / _ \ V  V (_-<      //
//      |_.__/\_,_|_| |_||_|   |_|_|_|  \_, |   \_/\_/|_|_||_|\__,_\___/\_/\_//__/      //
//                                 |__/                                                 //
//                       Copyright (c) 2021 Simon Schneegans                            //
//          Released under the GPLv3 or later. See LICENSE file for details.            //
//////////////////////////////////////////////////////////////////////////////////////////

'use strict';

const GObject = imports.gi.GObject;

const _ = imports.gettext.domain('burn-my-windows').gettext;

const ExtensionUtils = imports.misc.extensionUtils;
const Me             = imports.misc.extensionUtils.getCurrentExtension();
const utils          = Me.imports.src.utils;

//////////////////////////////////////////////////////////////////////////////////////////
// This effect looks a bit like the transporter effect from TNG.                        //
//////////////////////////////////////////////////////////////////////////////////////////

// The shader class for this effect is registered further down in this file. When this
// effect is used for the first time, an instance of this shader class is created. Once
// the effect is finished, the shader will be stored in the freeShaders array and will
// then be reused if a new shader is requested. ShaderClass which will be used whenever
// this effect is used.
let ShaderClass = null;
let freeShaders = [];

// The effect class is completely static. It can be used to get some metadata (like the
// effect's name or supported GNOME Shell versions), to initialize the respective page of
// the settings dialog, as well as to create the actual shader for the effect.
var EnergizeB = class EnergizeB {

  // ---------------------------------------------------------------------------- metadata

  // The effect is available on all GNOME Shell versions supported by this extension.
  static getMinShellVersion() {
    return [3, 36];
  }

  // This will be called in various places where a unique identifier for this effect is
  // required. It should match the prefix of the settings keys which store whether the
  // effect is enabled currently (e.g. '*-close-effect'), and its animation time
  // (e.g. '*-animation-time').
  static getNick() {
    return 'energize-b';
  }

  // This will be shown in the sidebar of the preferences dialog as well as in the
  // drop-down menus where the user can choose the effect.
  static getLabel() {
    return _('Energize B');
  }

  // -------------------------------------------------------------------- API for prefs.js

  // This is called by the preferences dialog. It loads the settings page for this effect,
  // binds all properties to the settings and appends the page to the main stack of the
  // preferences dialog.
  static getPreferences(dialog) {

    // Add the settings page to the builder.
    dialog.getBuilder().add_from_resource(`/ui/${utils.getGTKString()}/EnergizeB.ui`);

    // Bind all properties.
    dialog.bindAdjustment('energize-b-animation-time');
    dialog.bindAdjustment('energize-b-scale');
    dialog.bindColorButton('energize-b-color');

    // Finally, return the new settings page.
    return dialog.getBuilder().get_object('energize-b-prefs');
  }

  // ---------------------------------------------------------------- API for extension.js

  // This is called from extension.js whenever a window is opened or closed with this
  // effect. It returns an instance of the shader class, trying to reuse previously
  // created shaders.
  static getShader(actor, settings, forOpening) {
    let shader;

    if (freeShaders.length == 0) {
      shader = new ShaderClass();
    } else {
      shader = freeShaders.pop();
    }

    shader.setUniforms(actor, settings, forOpening);

    return shader;
  }

  // The getActorScale() is called from extension.js to adjust the actor's size during the
  // animation. This is useful if the effect requires drawing something beyond the usual
  // bounds of the actor. This only works for GNOME 3.38+.
  static getActorScale(settings) {
    return {x: 1.0, y: 1.0};
  }

  // This is called from extension.js if the extension is disabled. This should free all
  // static resources.
  static cleanUp() {
    freeShaders = [];
  }
}


//////////////////////////////////////////////////////////////////////////////////////////
// The shader class for this effect will only be registered in GNOME Shell's process    //
// (not in the preferences process). It's done this way as Clutter may not be installed //
// on the system and therefore the preferences would crash.                             //
//////////////////////////////////////////////////////////////////////////////////////////

if (utils.isInShellProcess()) {

  const {Clutter, Shell} = imports.gi;
  const shaderSnippets   = Me.imports.src.shaderSnippets;

  ShaderClass = GObject.registerClass({}, class ShaderClass extends Shell.GLSLEffect {
    // This is called when the effect is used for the first time. This can be used to
    // store all required uniform locations.
    _init() {
      super._init();

      this._uColor = this.get_uniform_location('uColor');
      this._uScale = this.get_uniform_location('uScale');
    }

    // This is called each time the effect is used. This can be used to retrieve the
    // configuration from the settings and update all uniforms accordingly.
    setUniforms(actor, settings, forOpening) {
      const c = Clutter.Color.from_string(settings.get_string('energize-b-color'))[1];

      // clang-format off
      this.set_uniform_float(this._uColor, 3, [c.red / 255, c.green / 255, c.blue / 255]);
      this.set_uniform_float(this._uScale, 1, [settings.get_double('energize-b-scale')]);
      // clang-format on
    }

    // This is called by extension.js when the shader is not used anymore. We will store
    // this instance of the shader so that it can be re-used in th future.
    free() {
      freeShaders.push(this);
    }

    // This is called by the constructor. This means, it's only called when the effect
    // is used for the first time.
    vfunc_build_pipeline() {
      const declarations = `
        // Inject some common shader snippets.
        ${shaderSnippets.standardUniforms()}
        ${shaderSnippets.noise()}
        ${shaderSnippets.edgeMask()}
        ${shaderSnippets.easing()}

        uniform vec3  uColor;
        uniform float uScale;

        const float SHOWER_TIME  = 0.3;
        const float SHOWER_WIDTH = 0.3;
        const float STREAK_TIME  = 0.6;
        const float EDGE_FADE    = 50;

        // This method returns four values:
        //  result.x: A mask for the particles which lead the shower.
        //  result.y: A mask for the streaks which follow the shower particles.
        //  result.z: A mask for the final "atom" particles.
        //  result.w: The opacity of the fading window.
        vec4 getMasks(float progress) {
          float showerProgress = progress/SHOWER_TIME;
          float streakProgress = clamp((progress-SHOWER_TIME)/STREAK_TIME, 0, 1);
          float fadeProgress  = clamp((progress-SHOWER_TIME)/(1.0 - SHOWER_TIME), 0, 1);

          // Gradient from top to bottom.
          float t = cogl_tex_coord_in[0].t;

          // A smooth gradient which moves to the bottom within the showerProgress.
          float showerMask = smoothstep(1, 0, abs(showerProgress - t - SHOWER_WIDTH) / SHOWER_WIDTH);

          // This is 1 above the streak mask.
          float streakMask = (showerProgress - t - SHOWER_WIDTH) > 0 ? 1 : 0;

          // Compute mask for the "atom" particles.
          float atomMask = getRelativeEdgeMask(0.2);
          atomMask = max(0, atomMask - showerMask);
          atomMask *= streakMask;
          atomMask *= sqrt(1-fadeProgress*fadeProgress);

          // Make some particles visible in the streaks.
          showerMask += 0.05 * streakMask;

          // Add shower mask to streak mask.
          streakMask = max(streakMask, showerMask);

          // Fade-out the masks at the window edges.
          float edgeFade = getAbsoluteEdgeMask(EDGE_FADE);
          streakMask *= edgeFade;
          showerMask *= edgeFade;
          
          // Fade-out the masks from top to bottom.
          float fade = smoothstep(0.0, 1.0, 1.0 + t - 2.0 * streakProgress);
          streakMask *= fade;
          showerMask *= fade;

          // Compute fading window opacity.
          float windowMask = pow(1.0 - fadeProgress, 2.0);

          if (uForOpening) {
            windowMask = 1.0 - windowMask;
          }

          return vec4(showerMask, streakMask, atomMask, windowMask);
        }
      `;

      const code = `
        float progress = easeOutQuad(uProgress);

        vec4 masks       = getMasks(progress);
        vec4 windowColor = texture2D(uTexture, cogl_tex_coord_in[0].st);

        // Shell.GLSLEffect uses straight alpha. So we have to convert from premultiplied.
        if (windowColor.a > 0) {
          windowColor.rgb /= windowColor.a;
        }

        // Dissolve window to effect color / transparency.
        cogl_color_out.rgb = mix(uColor, windowColor.rgb, 0.5 * masks.w + 0.5);
        cogl_color_out.a = windowColor.a * masks.w;

        // Add leading shower particles.
        vec2 showerUV = cogl_tex_coord_in[0].st + vec2(0, -0.7*progress/SHOWER_TIME);
        showerUV *= 0.02 * uSize / uScale;
        float shower = pow(simplex2D(showerUV), 10.0);
        cogl_color_out.rgb += uColor * shower * masks.x;
        cogl_color_out.a += shower * masks.x;

        // Add trailing streak lines.
        vec2 streakUV = cogl_tex_coord_in[0].st + vec2(0, -progress/SHOWER_TIME);
        streakUV *= vec2(0.05 * uSize.x, 0.001 * uSize.y) / uScale;
        float streaks = simplex2DFractal(streakUV) * 0.5;
        cogl_color_out.rgb += uColor * streaks * masks.y;
        cogl_color_out.a += streaks * masks.y;

        // Add glimmering atoms.
        vec2 atomUV = cogl_tex_coord_in[0].st + vec2(0, -0.025*progress/SHOWER_TIME);
        atomUV *= 0.2 * uSize / uScale;
        float atoms = pow((simplex3D(vec3(atomUV, uTime))), 5.0);
        cogl_color_out.rgb += uColor * atoms * masks.z;
        cogl_color_out.a += atoms * masks.z;

        // These are pretty useful for understanding how this works.
        // cogl_color_out = vec4(masks.rgb, 1.0);
        // cogl_color_out = vec4(vec3(masks.x), 1.0);
        // cogl_color_out = vec4(vec3(masks.y), 1.0);
        // cogl_color_out = vec4(vec3(masks.z), 1.0);
        // cogl_color_out = vec4(vec3(masks.w), 1.0);
        // cogl_color_out = vec4(vec3(shower), 1.0);
        // cogl_color_out = vec4(vec3(streaks), 1.0);
        // cogl_color_out = vec4(vec3(atoms), 1.0);
      `;

      this.add_glsl_snippet(Shell.SnippetHook.FRAGMENT, declarations, code, true);
    }
  });
}