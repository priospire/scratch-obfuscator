import {isScratchBlock, opcodePrefix} from '../model/blocks.js';
import type {ScratchProject} from '../types.js';
import {InputError} from '../errors.js';

function extensionOpcodeSurface(
  extensionId: string,
  blockOpcodes: readonly string[],
  menuNames: readonly string[]
): ReadonlySet<string> {
  return new Set([
    ...blockOpcodes.map(opcode => `${extensionId}_${opcode}`),
    ...menuNames.map(menuName => `${extensionId}_menu_${menuName}`)
  ]);
}

/** Blocks and serialized menu helpers registered by the bundled Scratch VM 15.1.0 extensions. */
export const OFFICIAL_EXTENSION_OPCODES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['boost', extensionOpcodeSurface('boost', [
    'getMotorPosition',
    'getTiltAngle',
    'motorOff',
    'motorOn',
    'motorOnFor',
    'motorOnForRotation',
    'seeingColor',
    'setLightHue',
    'setMotorDirection',
    'setMotorPower',
    'whenColor',
    'whenTilted'
  ], [
    'COLOR',
    'MOTOR_DIRECTION',
    'MOTOR_ID',
    'MOTOR_REPORTER_ID',
    'TILT_DIRECTION',
    'TILT_DIRECTION_ANY'
  ])],
  ['ev3', extensionOpcodeSurface('ev3', [
    'beep',
    'buttonPressed',
    'getBrightness',
    'getDistance',
    'getMotorPosition',
    'motorSetPower',
    'motorTurnClockwise',
    'motorTurnCounterClockwise',
    'whenBrightnessLessThan',
    'whenButtonPressed',
    'whenDistanceLessThan'
  ], ['motorPorts', 'sensorPorts'])],
  ['faceSensing', extensionOpcodeSurface('faceSensing', [
    'faceIsDetected',
    'faceSize',
    'faceTilt',
    'goToPart',
    'pointInFaceTiltDirection',
    'setSizeToFaceSize',
    'whenFaceDetected',
    'whenSpriteTouchesPart',
    'whenTilted'
  ], ['PART', 'TILT'])],
  ['gdxfor', extensionOpcodeSurface('gdxfor', [
    'getAcceleration',
    'getForce',
    'getSpinSpeed',
    'getTilt',
    'isFreeFalling',
    'isTilted',
    'whenForcePushedOrPulled',
    'whenGesture',
    'whenTilted'
  ], ['axisOptions', 'gestureOptions', 'pushPullOptions', 'tiltAnyOptions', 'tiltOptions'])],
  ['makeymakey', extensionOpcodeSurface('makeymakey', [
    'whenCodePressed',
    'whenMakeyKeyPressed'
  ], ['KEY', 'SEQUENCE'])],
  ['microbit', extensionOpcodeSurface('microbit', [
    'displayClear',
    'displaySymbol',
    'displayText',
    'getTiltAngle',
    'isButtonPressed',
    'isTilted',
    'whenButtonPressed',
    'whenGesture',
    'whenPinConnected',
    'whenTilted'
  ], ['buttons', 'gestures', 'pinState', 'tiltDirection', 'tiltDirectionAny', 'touchPins'])],
  ['music', extensionOpcodeSurface('music', [
    'changeTempo',
    'getTempo',
    'midiPlayDrumForBeats',
    'midiSetInstrument',
    'playDrumForBeats',
    'playNoteForBeats',
    'restForBeats',
    'setInstrument',
    'setTempo'
  ], ['DRUM', 'INSTRUMENT'])],
  ['pen', extensionOpcodeSurface('pen', [
    'changePenColorParamBy',
    'changePenHueBy',
    'changePenShadeBy',
    'changePenSizeBy',
    'clear',
    'penDown',
    'penUp',
    'setPenColorParamTo',
    'setPenColorToColor',
    'setPenHueToNumber',
    'setPenShadeToNumber',
    'setPenSizeTo',
    'stamp'
  ], ['colorParam'])],
  ['text2speech', extensionOpcodeSurface('text2speech', [
    'setLanguage',
    'setVoice',
    'speakAndWait'
  ], ['languages', 'voices'])],
  ['translate', extensionOpcodeSurface('translate', [
    'getTranslate',
    'getViewerLanguage'
  ], ['languages'])],
  ['videoSensing', extensionOpcodeSurface('videoSensing', [
    'setVideoTransparency',
    'videoOn',
    'videoToggle',
    'whenMotionGreaterThan'
  ], ['ATTRIBUTE', 'SUBJECT', 'VIDEO_STATE'])],
  ['wedo2', extensionOpcodeSurface('wedo2', [
    'getDistance',
    'getTiltAngle',
    'isTilted',
    'motorOff',
    'motorOn',
    'motorOnFor',
    'playNoteFor',
    'setLightHue',
    'setMotorDirection',
    'startMotorPower',
    'whenDistance',
    'whenTilted'
  ], ['MOTOR_DIRECTION', 'MOTOR_ID', 'OP', 'TILT_DIRECTION', 'TILT_DIRECTION_ANY'])]
]);

export const OFFICIAL_EXTENSION_IDS = new Set(OFFICIAL_EXTENSION_OPCODES.keys());

/** Core primitives, hats, legacy blocks, and serialized shadow/menu blocks in Scratch VM 15.1.0. */
export const OFFICIAL_CORE_OPCODES = new Set([
  'argument_editor_boolean',
  'argument_editor_string_number',
  'argument_reporter_boolean',
  'argument_reporter_string_number',
  'colour_picker',
  'control_all_at_once',
  'control_clear_counter',
  'control_create_clone_of',
  'control_create_clone_of_menu',
  'control_delete_this_clone',
  'control_for_each',
  'control_forever',
  'control_get_counter',
  'control_if',
  'control_if_else',
  'control_incr_counter',
  'control_repeat',
  'control_repeat_until',
  'control_start_as_clone',
  'control_stop',
  'control_wait',
  'control_wait_until',
  'control_while',
  'data_addtolist',
  'data_changevariableby',
  'data_deletealloflist',
  'data_deleteoflist',
  'data_hidelist',
  'data_hidevariable',
  'data_insertatlist',
  'data_itemnumoflist',
  'data_itemoflist',
  'data_lengthoflist',
  'data_listcontainsitem',
  'data_listcontents',
  'data_listindexall',
  'data_listindexrandom',
  'data_replaceitemoflist',
  'data_setvariableto',
  'data_showlist',
  'data_showvariable',
  'data_variable',
  'event_broadcast',
  'event_broadcast_menu',
  'event_broadcastandwait',
  'event_touchingobjectmenu',
  'event_whenbackdropswitchesto',
  'event_whenbroadcastreceived',
  'event_whenflagclicked',
  'event_whengreaterthan',
  'event_whenkeypressed',
  'event_whenstageclicked',
  'event_whenthisspriteclicked',
  'event_whentouchingobject',
  'looks_backdropnumbername',
  'looks_backdrops',
  'looks_changeeffectby',
  'looks_changesizeby',
  'looks_changestretchby',
  'looks_cleargraphiceffects',
  'looks_costumenumbername',
  'looks_costume',
  'looks_goforwardbackwardlayers',
  'looks_gotofrontback',
  'looks_hide',
  'looks_hideallsprites',
  'looks_nextbackdrop',
  'looks_nextcostume',
  'looks_say',
  'looks_sayforsecs',
  'looks_seteffectto',
  'looks_setsizeto',
  'looks_setstretchto',
  'looks_show',
  'looks_size',
  'looks_switchbackdropto',
  'looks_switchbackdroptoandwait',
  'looks_switchcostumeto',
  'looks_think',
  'looks_thinkforsecs',
  'math_angle',
  'math_integer',
  'math_number',
  'math_positive_number',
  'math_whole_number',
  'matrix',
  'motion_align_scene',
  'motion_changexby',
  'motion_changeyby',
  'motion_direction',
  'motion_glidesecstoxy',
  'motion_glideto',
  'motion_glideto_menu',
  'motion_goto',
  'motion_goto_menu',
  'motion_gotoxy',
  'motion_ifonedgebounce',
  'motion_movesteps',
  'motion_pointindirection',
  'motion_pointtowards',
  'motion_pointtowards_menu',
  'motion_scroll_right',
  'motion_scroll_up',
  'motion_setrotationstyle',
  'motion_setx',
  'motion_sety',
  'motion_turnleft',
  'motion_turnright',
  'motion_xposition',
  'motion_xscroll',
  'motion_yposition',
  'motion_yscroll',
  'note',
  'operator_add',
  'operator_and',
  'operator_contains',
  'operator_divide',
  'operator_equals',
  'operator_gt',
  'operator_join',
  'operator_length',
  'operator_letter_of',
  'operator_lt',
  'operator_mathop',
  'operator_mod',
  'operator_multiply',
  'operator_not',
  'operator_or',
  'operator_random',
  'operator_round',
  'operator_subtract',
  'procedures_call',
  'procedures_declaration',
  'procedures_definition',
  'procedures_prototype',
  'sensing_answer',
  'sensing_askandwait',
  'sensing_coloristouchingcolor',
  'sensing_current',
  'sensing_dayssince2000',
  'sensing_distanceto',
  'sensing_distancetomenu',
  'sensing_keyoptions',
  'sensing_keypressed',
  'sensing_loud',
  'sensing_loudness',
  'sensing_mousedown',
  'sensing_mousex',
  'sensing_mousey',
  'sensing_of',
  'sensing_of_object_menu',
  'sensing_online',
  'sensing_resettimer',
  'sensing_setdragmode',
  'sensing_timer',
  'sensing_touchingcolor',
  'sensing_touchingobject',
  'sensing_touchingobjectmenu',
  'sensing_userid',
  'sensing_username',
  'sound_beats_menu',
  'sound_changeeffectby',
  'sound_changevolumeby',
  'sound_cleareffects',
  'sound_effects_menu',
  'sound_play',
  'sound_playuntildone',
  'sound_seteffectto',
  'sound_setvolumeto',
  'sound_sounds_menu',
  'sound_stopallsounds',
  'sound_volume',
  'text'
]);

const OFFICIAL_CORE_LITERAL_SHADOW_OPCODES = [
  'argument_editor_boolean',
  'argument_editor_string_number',
  'colour_picker',
  'control_create_clone_of_menu',
  'data_listindexall',
  'data_listindexrandom',
  'event_broadcast_menu',
  'event_touchingobjectmenu',
  'looks_backdrops',
  'looks_costume',
  'math_angle',
  'math_integer',
  'math_number',
  'math_positive_number',
  'math_whole_number',
  'matrix',
  'motion_glideto_menu',
  'motion_goto_menu',
  'motion_pointtowards_menu',
  'note',
  'procedures_declaration',
  'procedures_prototype',
  'sensing_distancetomenu',
  'sensing_keyoptions',
  'sensing_of_object_menu',
  'sensing_touchingobjectmenu',
  'sound_beats_menu',
  'sound_effects_menu',
  'sound_sounds_menu',
  'text'
] as const;

/** Official shadows whose pinned runtime value is their sole field when they have no inputs. */
export const OFFICIAL_LITERAL_SHADOW_OPCODES: ReadonlySet<string> = new Set([
  ...OFFICIAL_CORE_LITERAL_SHADOW_OPCODES,
  ...[...OFFICIAL_EXTENSION_OPCODES].flatMap(([extensionId, opcodes]) => (
    [...opcodes].filter(opcode => opcode.startsWith(`${extensionId}_menu_`))
  ))
]);

export function isOfficialHatOpcode(opcode: string): boolean {
  if (OFFICIAL_CORE_OPCODES.has(opcode)) {
    return opcode.startsWith('event_when') || opcode === 'control_start_as_clone';
  }
  const separator = opcode.indexOf('_');
  return separator > 0
    && OFFICIAL_EXTENSION_OPCODES.get(opcode.slice(0, separator))?.has(opcode) === true
    && opcode.slice(separator + 1).startsWith('when');
}

export function validateOfficialExtensions(project: ScratchProject): void {
  const declared = new Set<string>();
  for (const extension of project.extensions) {
    if (!OFFICIAL_EXTENSION_IDS.has(extension)) {
      throw new InputError(`unsupported extension: ${JSON.stringify(extension)}`);
    }
    if (declared.has(extension)) {
      throw new InputError(`duplicate extension declaration: ${JSON.stringify(extension)}`);
    }
    declared.add(extension);
  }

  for (let targetIndex = 0; targetIndex < project.targets.length; targetIndex += 1) {
    const target = project.targets[targetIndex];
    if (!target) continue;
    for (const [blockId, value] of Object.entries(target.blocks)) {
      if (!isScratchBlock(value)) continue;
      validateOpcode(value.opcode, declared, `target ${targetIndex} block ${JSON.stringify(blockId)}`);
    }
  }
  for (let monitorIndex = 0; monitorIndex < project.monitors.length; monitorIndex += 1) {
    const opcode = project.monitors[monitorIndex]?.['opcode'];
    if (typeof opcode === 'string') validateOpcode(opcode, declared, `monitor ${monitorIndex}`);
  }
}

function validateOpcode(opcode: string, declared: ReadonlySet<string>, location: string): void {
  if (OFFICIAL_CORE_OPCODES.has(opcode)) return;
  const prefix = opcodePrefix(opcode);
  const extensionOpcodes = OFFICIAL_EXTENSION_OPCODES.get(prefix);
  if (extensionOpcodes) {
    if (!extensionOpcodes.has(opcode)) {
      throw new InputError(
        `${location} has unsupported opcode ${JSON.stringify(opcode)} for bundled extension ${JSON.stringify(prefix)}`
      );
    }
    if (!declared.has(prefix)) {
      throw new InputError(`${location} uses undeclared extension ${JSON.stringify(prefix)}`);
    }
    return;
  }
  throw new InputError(`${location} has unsupported opcode ${JSON.stringify(opcode)}`);
}
