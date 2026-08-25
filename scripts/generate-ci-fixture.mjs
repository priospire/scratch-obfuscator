import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {zipSync, strToU8} from 'fflate';

const output = process.argv[2];
if (!output) throw new Error('usage: generate-ci-fixture.mjs <output.sb3>');

const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#4c97ff"/></svg>');
const assetId = createHash('md5').update(svg).digest('hex');
const costume = name => ({
  assetId,
  name,
  md5ext: `${assetId}.svg`,
  dataFormat: 'svg',
  rotationCenterX: 0,
  rotationCenterY: 0
});

const project = {
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: {
        global_score: ['Readable score', 0],
        stage_alpha: ['Readable stage alpha', 'stage-alpha-initial-v2'],
        stage_beta: ['Readable stage beta', 'stage-beta-initial-v2']
      },
      lists: {global_list: ['Readable list', ['alpha', 'beta']]},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [costume('backdrop1')],
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
      variables: {
        sprite_alpha: ['Readable sprite alpha', 'sprite-alpha-initial-v2'],
        sprite_beta: ['Readable sprite beta', 'sprite-beta-initial-v2']
      },
      lists: {},
      broadcasts: {},
      blocks: {
        sprite_flag: {
          opcode: 'event_whenflagclicked', next: 'sprite_set_stage', parent: null,
          inputs: {}, fields: {}, shadow: false, topLevel: true, x: 160, y: 240
        },
        sprite_set_stage: {
          opcode: 'data_setvariableto', next: 'sprite_set_stage_beta', parent: 'sprite_flag',
          inputs: {VALUE: [1, [10, 'stage-alpha-runtime-v2']]},
          fields: {VARIABLE: ['Readable stage alpha', 'stage_alpha']},
          shadow: false, topLevel: false, comment: 'fixture_comment'
        },
        sprite_set_stage_beta: {
          opcode: 'data_setvariableto', next: 'sprite_set_local', parent: 'sprite_set_stage',
          inputs: {VALUE: [1, [10, 'stage-beta-runtime-v2']]},
          fields: {VARIABLE: ['Readable stage beta', 'stage_beta']},
          shadow: false, topLevel: false
        },
        sprite_set_local: {
          opcode: 'data_setvariableto', next: 'sprite_set_local_beta', parent: 'sprite_set_stage_beta',
          inputs: {VALUE: [1, [10, 'sprite-alpha-runtime-v2']]},
          fields: {VARIABLE: ['Readable sprite alpha', 'sprite_alpha']},
          shadow: false, topLevel: false
        },
        sprite_set_local_beta: {
          opcode: 'data_setvariableto', next: 'sprite_set_x', parent: 'sprite_set_local',
          inputs: {VALUE: [1, [10, 'sprite-beta-runtime-v2']]},
          fields: {VARIABLE: ['Readable sprite beta', 'sprite_beta']},
          shadow: false, topLevel: false
        },
        sprite_set_x: {
          opcode: 'motion_setx', next: 'sprite_set_y', parent: 'sprite_set_local_beta',
          inputs: {X: [3, 'static_multiply', [4, '999']]}, fields: {},
          shadow: false, topLevel: false
        },
        static_multiply: {
          opcode: 'operator_multiply', next: null, parent: 'sprite_set_x',
          inputs: {NUM1: [2, 'static_add'], NUM2: [1, [4, '8']]}, fields: {},
          shadow: false, topLevel: false
        },
        static_add: {
          opcode: 'operator_add', next: null, parent: 'static_multiply',
          inputs: {NUM1: [1, [4, '5']], NUM2: [1, [4, '4']]}, fields: {},
          shadow: false, topLevel: false
        },
        sprite_set_y: {
          opcode: 'motion_sety', next: 'sprite_set_size', parent: 'sprite_set_x',
          inputs: {Y: [3, 'stage_reporter', [4, '777']]}, fields: {},
          shadow: false, topLevel: false
        },
        stage_reporter: {
          opcode: 'data_variable', next: null, parent: 'sprite_set_y', inputs: {},
          fields: {VARIABLE: ['Readable stage alpha', 'stage_alpha']},
          shadow: false, topLevel: false
        },
        sprite_set_size: {
          opcode: 'looks_setsizeto', next: 'sprite_set_volume', parent: 'sprite_set_y',
          inputs: {SIZE: [1, [4, '83']]}, fields: {}, shadow: false, topLevel: false
        },
        sprite_set_volume: {
          opcode: 'sound_setvolumeto', next: 'dispatcher_separator', parent: 'sprite_set_size',
          inputs: {VOLUME: [1, [4, '37']]}, fields: {}, shadow: false, topLevel: false
        },
        dispatcher_separator: {
          opcode: 'motion_setrotationstyle', next: 'dispatcher_change_x', parent: 'sprite_set_volume',
          inputs: {}, fields: {STYLE: ['left-right', null]}, shadow: false, topLevel: false
        },
        dispatcher_change_x: {
          opcode: 'motion_changexby', next: 'dispatcher_change_y', parent: 'dispatcher_separator',
          inputs: {DX: [1, [4, '11']]}, fields: {}, shadow: false, topLevel: false
        },
        dispatcher_change_y: {
          opcode: 'motion_changeyby', next: 'dispatcher_change_size', parent: 'dispatcher_change_x',
          inputs: {DY: [1, [4, '-7']]}, fields: {}, shadow: false, topLevel: false
        },
        dispatcher_change_size: {
          opcode: 'looks_changesizeby', next: 'dispatcher_change_volume', parent: 'dispatcher_change_y',
          inputs: {CHANGE: [1, [4, '13']]}, fields: {}, shadow: false, topLevel: false
        },
        dispatcher_change_volume: {
          opcode: 'sound_changevolumeby', next: null, parent: 'dispatcher_change_size',
          inputs: {VOLUME: [1, [4, '-9']]}, fields: {}, shadow: false, topLevel: false
        }
      },
      comments: {
        fixture_comment: {
          blockId: 'sprite_set_stage', x: 0, y: 0, width: 200, height: 100, minimized: false,
          text: 'Readable release-fixture comment'
        }
      },
      currentCostume: 0,
      costumes: [costume('costume1')],
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
    id: 'global_score', mode: 'default', opcode: 'data_variable', params: {VARIABLE: 'Readable score'},
    spriteName: null, value: 0, width: 0, height: 0, x: 5, y: 5, visible: true,
    sliderMin: 0, sliderMax: 100, isDiscrete: true
  }],
  extensions: [],
  meta: {semver: '3.0.0', vm: '15.1.0', agent: 'scratch-obfuscator-release-fixture-v2'}
};

const archive = zipSync({
  [`${assetId}.svg`]: [svg, {level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0)}],
  'project.json': [strToU8(JSON.stringify(project, null, 2)), {level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0)}]
});
await writeFile(output, archive);
