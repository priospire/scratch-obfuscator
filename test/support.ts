import {createHash} from 'node:crypto';
import {strToU8, unzipSync, zipSync} from 'fflate';
import type {Zippable} from 'fflate';
import type {ScratchProject} from '../src/types.js';

export const SVG_BYTES = strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#4c97ff"/></svg>');
export const SVG_ID = createHash('md5').update(SVG_BYTES).digest('hex');
export const SVG_NAME = `${SVG_ID}.svg`;

const costume = () => ({
  assetId: SVG_ID,
  name: 'visible costume',
  md5ext: SVG_NAME,
  dataFormat: 'svg',
  rotationCenterX: 0,
  rotationCenterY: 0
});

export function createFixtureProject(): ScratchProject {
  return structuredClone({
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {
          global_score: ['Readable score', 0],
          cloud_value: ['☁ cloud value', 1, true]
        },
        lists: {global_list: ['Readable list', ['alpha', 'beta']]},
        broadcasts: {broadcast_go: 'go'},
        blocks: {
          start_script: {
            opcode: 'event_whenflagclicked',
            next: 'set_score',
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 120,
            y: 80,
            comment: 'comment_one'
          },
          set_score: {
            opcode: 'data_setvariableto',
            next: 'show_stage',
            parent: 'start_script',
            inputs: {VALUE: [1, [4, '42']]},
            fields: {VARIABLE: ['Readable score', 'global_score']},
            shadow: false,
            topLevel: false
          },
          show_stage: {
            opcode: 'looks_show',
            next: 'move_x',
            parent: 'set_score',
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: false
          },
          move_x: {
            opcode: 'motion_setx',
            next: 'move_y',
            parent: 'show_stage',
            inputs: {X: [1, [4, '12']]},
            fields: {},
            shadow: false,
            topLevel: false
          },
          move_y: {
            opcode: 'motion_sety',
            next: 'hide_stage',
            parent: 'move_x',
            inputs: {Y: [1, [4, '-7']]},
            fields: {},
            shadow: false,
            topLevel: false
          },
          hide_stage: {
            opcode: 'looks_hide',
            next: 'broadcast_message',
            parent: 'move_y',
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: false
          },
          broadcast_message: {
            opcode: 'event_broadcast',
            next: null,
            parent: 'hide_stage',
            inputs: {BROADCAST_INPUT: [1, [11, 'go', 'broadcast_go']]},
            fields: {},
            shadow: false,
            topLevel: false
          }
        },
        comments: {
          comment_one: {
            blockId: 'start_script',
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            minimized: false,
            text: 'Readable comment'
          }
        },
        currentCostume: 0,
        costumes: [costume()],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
        textToSpeechLanguage: null
      },
      {
        isStage: false,
        name: 'Visible Sprite',
        variables: {local_score: ['Readable score', 3]},
        lists: {},
        broadcasts: {},
        blocks: {
          receive_script: {
            opcode: 'event_whenbroadcastreceived',
            next: 'change_local',
            parent: null,
            inputs: {},
            fields: {BROADCAST_OPTION: ['go', 'broadcast_go']},
            shadow: false,
            topLevel: true,
            x: 300,
            y: 100
          },
          change_local: {
            opcode: 'data_changevariableby',
            next: 'move_sprite',
            parent: 'receive_script',
            inputs: {VALUE: [1, [4, '1']]},
            fields: {VARIABLE: ['Readable score', 'local_score']},
            shadow: false,
            topLevel: false
          },
          move_sprite: {
            opcode: 'motion_changexby',
            next: null,
            parent: 'change_local',
            inputs: {DX: [1, [4, '5']]},
            fields: {},
            shadow: false,
            topLevel: false
          }
        },
        comments: {},
        currentCostume: 0,
        costumes: [costume()],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around'
      }
    ],
    monitors: [{
      id: 'global_score',
      mode: 'default',
      opcode: 'data_variable',
      params: {VARIABLE: 'Readable score'},
      spriteName: null,
      value: 0,
      width: 0,
      height: 0,
      x: 5,
      y: 5,
      visible: true,
      sliderMin: 0,
      sliderMax: 100,
      isDiscrete: true
    }],
    extensions: [],
    meta: {semver: '3.0.0', vm: '15.1.0', agent: 'test fixture'}
  });
}

export function createFixtureArchive(project = createFixtureProject(), reversed = false): Uint8Array {
  const projectBytes = strToU8(JSON.stringify(project, null, 2));
  const date = reversed ? new Date('2023-02-03T04:05:06Z') : new Date('2025-06-07T08:09:10Z');
  const entries: Zippable = reversed
    ? {'project.json': [projectBytes, {level: 1, mtime: date}], [SVG_NAME]: [SVG_BYTES, {level: 1, mtime: date}]}
    : {[SVG_NAME]: [SVG_BYTES, {level: 9, mtime: date}], 'project.json': [projectBytes, {level: 9, mtime: date}]};
  return zipSync(entries);
}

export function readProjectFromArchive(archive: Uint8Array): ScratchProject {
  const entries = unzipSync(archive);
  const bytes = entries['project.json'];
  if (!bytes) throw new Error('missing project.json');
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as ScratchProject;
}
