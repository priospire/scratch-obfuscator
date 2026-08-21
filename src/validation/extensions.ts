import {isScratchBlock, opcodePrefix} from '../model/blocks.js';
import type {ScratchProject} from '../types.js';
import {InputError} from '../errors.js';

export const OFFICIAL_EXTENSION_IDS = new Set([
  'boost',
  'ev3',
  'faceSensing',
  'gdxfor',
  'makeymakey',
  'microbit',
  'music',
  'pen',
  'text2speech',
  'translate',
  'videoSensing',
  'wedo2'
]);

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
  if (OFFICIAL_EXTENSION_IDS.has(prefix)) {
    if (!declared.has(prefix)) {
      throw new InputError(`${location} uses undeclared extension ${JSON.stringify(prefix)}`);
    }
    return;
  }
  throw new InputError(`${location} has unsupported opcode ${JSON.stringify(opcode)}`);
}
