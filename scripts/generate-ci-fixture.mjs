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
      variables: {global_score: ['Readable score', 0]},
      lists: {global_list: ['Readable list', ['alpha', 'beta']]},
      broadcasts: {broadcast_go: 'go'},
      blocks: {
        stage_flag: {
          opcode: 'event_whenflagclicked', next: 'stage_set_score', parent: null,
          inputs: {}, fields: {}, shadow: false, topLevel: true, x: 120, y: 80
        },
        stage_set_score: {
          opcode: 'data_setvariableto', next: 'stage_change_score', parent: 'stage_flag',
          inputs: {VALUE: [1, [4, '40']]}, fields: {VARIABLE: ['Readable score', 'global_score']},
          shadow: false, topLevel: false, comment: 'stage_note'
        },
        stage_change_score: {
          opcode: 'data_changevariableby', next: 'stage_add_item', parent: 'stage_set_score',
          inputs: {VALUE: [1, [4, '2']]}, fields: {VARIABLE: ['Readable score', 'global_score']},
          shadow: false, topLevel: false
        },
        stage_add_item: {
          opcode: 'data_addtolist', next: 'stage_replace_item', parent: 'stage_change_score',
          inputs: {ITEM: [1, [10, 'gamma']]}, fields: {LIST: ['Readable list', 'global_list']},
          shadow: false, topLevel: false
        },
        stage_replace_item: {
          opcode: 'data_replaceitemoflist', next: 'stage_custom_call', parent: 'stage_add_item',
          inputs: {INDEX: [1, [4, '1']], ITEM: [1, [10, 'omega']]}, fields: {LIST: ['Readable list', 'global_list']},
          shadow: false, topLevel: false
        },
        stage_custom_call: {
          opcode: 'procedures_call', next: 'stage_broadcast', parent: 'stage_replace_item', inputs: {}, fields: {},
          shadow: false, topLevel: false,
          mutation: {
            tagName: 'mutation', children: [], proccode: 'record completion', argumentids: '[]', warp: 'false'
          }
        },
        stage_broadcast: {
          opcode: 'event_broadcast', next: null, parent: 'stage_custom_call',
          inputs: {BROADCAST_INPUT: [1, [11, 'go', 'broadcast_go']]}, fields: {}, shadow: false, topLevel: false
        },
        stage_custom_definition: {
          opcode: 'procedures_definition', next: 'stage_custom_body', parent: null,
          inputs: {custom_block: [1, 'stage_custom_prototype']}, fields: {},
          shadow: false, topLevel: true, x: 460, y: 80
        },
        stage_custom_prototype: {
          opcode: 'procedures_prototype', next: null, parent: 'stage_custom_definition', inputs: {}, fields: {},
          shadow: true, topLevel: false,
          mutation: {
            tagName: 'mutation', children: [], proccode: 'record completion', argumentids: '[]',
            argumentnames: '[]', argumentdefaults: '[]', warp: 'false'
          }
        },
        stage_custom_body: {
          opcode: 'data_addtolist', next: null, parent: 'stage_custom_definition',
          inputs: {ITEM: [1, [10, 'complete']]}, fields: {LIST: ['Readable list', 'global_list']},
          shadow: false, topLevel: false
        },
        stage_pen_payload: {
          opcode: 'pen_clear', next: null, parent: null, inputs: {}, fields: {},
          shadow: false, topLevel: true, x: 680, y: 80
        }
      },
      comments: {
        stage_note: {
          blockId: 'stage_set_score', x: 0, y: 0, width: 200, height: 100, minimized: false,
          text: 'Readable release-fixture comment'
        }
      },
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
      variables: {sprite_value: ['Readable sprite value', 3]},
      lists: {},
      broadcasts: {},
      blocks: {
        sprite_flag: {
          opcode: 'event_whenflagclicked', next: 'sprite_set_x', parent: null,
          inputs: {}, fields: {}, shadow: false, topLevel: true, x: 160, y: 240
        },
        sprite_set_x: {
          opcode: 'motion_setx', next: 'sprite_set_y', parent: 'sprite_flag',
          inputs: {X: [1, [4, '11']]}, fields: {}, shadow: false, topLevel: false
        },
        sprite_set_y: {
          opcode: 'motion_sety', next: 'sprite_set_size', parent: 'sprite_set_x',
          inputs: {Y: [1, [4, '-7']]}, fields: {}, shadow: false, topLevel: false
        },
        sprite_set_size: {
          opcode: 'looks_setsizeto', next: 'sprite_set_volume', parent: 'sprite_set_y',
          inputs: {SIZE: [1, [4, '83']]}, fields: {}, shadow: false, topLevel: false
        },
        sprite_set_volume: {
          opcode: 'sound_setvolumeto', next: null, parent: 'sprite_set_size',
          inputs: {VOLUME: [1, [4, '37']]}, fields: {}, shadow: false, topLevel: false
        }
      },
      comments: {},
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
  extensions: ['pen'],
  meta: {semver: '3.0.0', vm: '15.1.0', agent: 'scratch-obfuscator-release-fixture-v1'}
};

const archive = zipSync({
  [`${assetId}.svg`]: [svg, {level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0)}],
  'project.json': [strToU8(JSON.stringify(project, null, 2)), {level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0)}]
});
await writeFile(output, archive);
