import chalk from 'chalk';
import { Command } from 'commander';
import * as utils from './utils';

import { clean } from './clean';
import * as compiler from './compiler';
import * as config from './config';
import * as contract from './contract';
import * as db from './database';
import * as docker from './docker';
import * as env from './env';
import * as run from './run';
import * as server from './server';
import { up } from './up';

import * as fs from 'fs';
import * as constants from './constants';
import { Console } from 'console';

const entry = chalk.bold.yellow;
const announce = chalk.yellow;
const success = chalk.green;
const timestamp = chalk.grey;
const CHAIN_CONFIG_PATH = 'etc/env/base/chain.toml';
const ETH_SENDER_PATH = 'etc/env/base/eth_sender.toml';
const EXT_NODE_PATH = 'etc/env/ext-node.toml';

export async function init(initArgs: InitArgs = DEFAULT_ARGS) {
    const {
        skipSubmodulesCheckout,
        skipEnvSetup,
        testTokens,
        governorPrivateKeyArgs,
        deployerPrivateKeyArgs,
        deployerL2ContractInput,
        validiumMode
    } = initArgs;

    await announced(`Initializing in ${validiumMode ? 'Validium mode' : 'Roll-up mode'}`);
    process.env.VALIDIUM_MODE = validiumMode.toString();
    await announced('Updating mode configuration', updateConfig(validiumMode));
    if (!process.env.CI && !skipEnvSetup) {
        await announced('Pulling images', docker.pull());
        await announced('Checking environment', checkEnv());
        await announced('Checking git hooks', env.gitHooks());
        await announced('Setting up containers', up());
    }
    if (!skipSubmodulesCheckout) {
        await announced('Checkout system-contracts submodule', submoduleUpdate());
    }

    await announced('Compiling JS packages', run.yarn());
    await announced('Compile l2 contracts', compiler.compileAll());
    await announced('Drop postgres db', db.drop({ server: true, prover: true }));
    await announced('Setup postgres db', db.setup({ server: true, prover: true }));
    await announced('Clean rocksdb', clean('db'));
    await announced('Clean backups', clean('backups'));
    await announced('Building contracts', contract.build());
    if (testTokens.deploy) {
        await announced('Deploying localhost ERC20 tokens', run.deployERC20('dev', '', '', '', testTokens.args));
    }
    await announced('Deploying L1 verifier', contract.deployVerifier(deployerPrivateKeyArgs));
    await announced('Reloading env', env.reload());
    await announced('Running server genesis setup', server.genesisFromSources());
    await announced('Deploying L1 contracts', contract.redeployL1(deployerPrivateKeyArgs));
    await announced('Initializing validator', contract.initializeValidator(governorPrivateKeyArgs));
    await announced(
        'Deploying L2 contracts',
        contract.deployL2(
            deployerL2ContractInput.args,
            deployerL2ContractInput.includePaymaster,
            deployerL2ContractInput.includeL2WETH
        )
    );

    if (deployerL2ContractInput.includeL2WETH) {
        await announced('Initializing L2 WETH token', contract.initializeWethToken(governorPrivateKeyArgs));
    }
    await announced('Initializing governance', contract.initializeGovernance(governorPrivateKeyArgs));
}

// A smaller version of `init` that "resets" the localhost environment, for which `init` was already called before.
// It does less and runs much faster.
export async function reinit(validiumMode: boolean) {
    process.env.VALIDIUM_MODE = validiumMode.toString();
    await announced(`Initializing in ${validiumMode ? 'Validium mode' : 'Roll-up mode'}`);
    await announced('Updating mode configuration', updateConfig(validiumMode));
    await announced('Setting up containers', up());
    await announced('Compiling JS packages', run.yarn());
    await announced('Compile l2 contracts', compiler.compileAll());
    await announced('Drop postgres db', db.drop({ server: true, prover: true }));
    await announced('Setup postgres db', db.setup({ server: true, prover: true }));
    await announced('Clean rocksdb', clean('db'));
    await announced('Clean backups', clean('backups'));
    await announced('Building contracts', contract.build());
    await announced('Deploying L1 verifier', contract.deployVerifier([]));
    await announced('Reloading env', env.reload());
    await announced('Running server genesis setup', server.genesisFromSources());
    await announced('Deploying L1 contracts', contract.redeployL1([]));
    await announced('Deploying L2 contracts', contract.deployL2([], true, true));
    await announced('Initializing L2 WETH token', contract.initializeWethToken());
    await announced('Initializing governance', contract.initializeGovernance());
    await announced('Initializing validator', contract.initializeValidator());
}

// A lightweight version of `init` that sets up local databases, generates genesis and deploys precompiled contracts
export async function lightweightInit(validiumMode: boolean) {
    process.env.VALIDIUM_MODE = validiumMode.toString();
    await announced(`Initializing in ${validiumMode ? 'Validium mode' : 'Roll-up mode'}`);
    await announced('Updating mode configuration', updateConfig(validiumMode));
    await announced(`Setting up containers`, up());
    await announced('Clean rocksdb', clean('db'));
    await announced('Clean backups', clean('backups'));
    await announced('Deploying L1 verifier', contract.deployVerifier([]));
    await announced('Reloading env', env.reload());
    await announced('Running server genesis setup', server.genesisFromBinary());
    await announced('Deploying localhost ERC20 tokens', run.deployERC20('dev', '', '', '', []));
    await announced('Deploying L1 contracts', contract.redeployL1([]));
    await announced('Initializing validator', contract.initializeValidator());
    await announced('Deploying L2 contracts', contract.deployL2([], true, false));
    await announced('Initializing governance', contract.initializeGovernance());
}

// Wrapper that writes an announcement and completion notes for each executed task.
export async function announced(fn: string, promise: Promise<void> | void) {
    const announceLine = `${entry('>')} ${announce(fn)}`;
    const separator = '-'.repeat(fn.length + 2); // 2 is the length of "> ".
    console.log(`\n` + separator); // So it's easier to see each individual step in the console.
    console.log(announceLine);

    const start = new Date().getTime();
    // The actual execution part
    await promise;

    const time = new Date().getTime() - start;
    const successLine = `${success('✔')} ${fn} done`;
    const timestampLine = timestamp(`(${time}ms)`);
    console.log(`${successLine} ${timestampLine}`);
}

export async function submoduleUpdate() {
    await utils.exec('git submodule init');
    await utils.exec('git submodule update');
}

interface ConfigLine {
    key: string;
    value: string | number | null;
    section: string | null;
    lineIndex?: number | null;
}

function updateConfigFile(path: string, updatedConfigLines: ConfigLine[]) {
    let content = fs.readFileSync(path, 'utf-8');
    let lines = content.split('\n');
    let addedContent: string | undefined;
    const lineIndices: Record<string, number> = {};
    const sectionIndices: Record<string, number> = {};

    // Iterate through each line in the file
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Check if the line does not start with '#' (comment)
        if (!line.startsWith('#')) {
            // Using regex to match sections in the line
            const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
            if (sectionMatch) {
                const section = sectionMatch[1].trim();
                sectionIndices[section] = i;
            }
            // Using regex to match key-value pairs in the line
            const match = line.match(/([^=]+)=(.*)/);

            if (match) {
                const key = match[1].trim();
                lineIndices[key] = i;
            }
        }
    }

    // Iterate through each config line in updatedConfigLines
    updatedConfigLines.forEach((configLine) => {
        // Get the position of the line in the file
        const lineIndex = lineIndices[configLine.key];
        // Get the position of the section in the file
        const sectionIndex = sectionIndices[configLine.section!];

        // If config line is already in the file
        if (lineIndex !== undefined) {
            // Update value
            if (configLine.value !== null) {
                lines.splice(lineIndex, 1, `${configLine.key}=${configLine.value}`);
            } else {
                // Remove line
                lines.splice(lineIndex, 1);

                //Update line indices
                Object.entries(lineIndices)
                    .filter(([k, index]) => index > lineIndex)
                    .forEach(([k, index]) => {
                        lineIndices[k] = index - 1;
                    });
                Object.entries(sectionIndices)
                    .filter(([k, index]) => index > lineIndex)
                    .forEach(([k, index]) => {
                        sectionIndices[k] = index - 1;
                    });
            }
        } else {
            // If config line is not in the file, add it
            if (configLine.value !== null) {
                // If is inside a section and new config line, add the line at the start of the section
                if (sectionIndex !== undefined) {
                    lines.splice(sectionIndex + 1, 0, `${configLine.key}=${configLine.value}`);
                    // Update line indices
                    Object.entries(lineIndices)
                        .filter(([k, index]) => index > sectionIndex)
                        .forEach(([k, index]) => {
                            lineIndices[k] = index + 1;
                        });
                    Object.entries(sectionIndices)
                        .filter(([k, index]) => index > sectionIndex)
                        .forEach(([k, index]) => {
                            sectionIndices[k] = index + 1;
                        });
                } else {
                    // If is not inside a section, add the line at the end of the file
                    addedContent = `${configLine.key}=${configLine.value}\n`;
                }
            }
        }
    });

    // Join the lines back into a single string with line breaks
    content = lines.join('\n');

    // Append the additional content (if any) to the end of the file content
    if (addedContent) {
        content += addedContent;
    }

    // Write the modified content back to the file
    fs.writeFileSync(path, content);
}

function updateChainConfig(validiumMode: boolean) {
    const updatedConfigLines: ConfigLine[] = [
        {
            key: 'compute_overhead_part',
            value: validiumMode ? constants.VALIDIUM_COMPUTE_OVERHEAD_PART : constants.ROLLUP_COMPUTE_OVERHEAD_PART,
            section: null
        },
        {
            key: 'pubdata_overhead_part',
            value: validiumMode ? constants.VALIDIUM_PUBDATA_OVERHEAD_PART : constants.ROLLUP_PUBDATA_OVERHEAD_PART,
            section: null
        },
        {
            key: 'batch_overhead_l1_gas',
            value: validiumMode ? constants.VALIDIUM_BATCH_OVERHEAD_L1_GAS : constants.ROLLUP_BATCH_OVERHEAD_L1_GAS,
            section: null
        },
        {
            key: 'max_pubdata_per_batch',
            value: validiumMode ? constants.VALIDIUM_MAX_PUBDATA_PER_BATCH : constants.ROLLUP_MAX_PUBDATA_PER_BATCH,
            section: null
        },
        {
            key: 'l1_batch_commit_data_generator_mode',
            value: validiumMode
                ? constants.VALIDIUM_L1_BATCH_COMMIT_DATA_GENERATOR_MODE
                : constants.ROLLUP_L1_BATCH_COMMIT_DATA_GENERATOR_MODE,
            section: null
        }
    ];
    updateConfigFile(CHAIN_CONFIG_PATH, updatedConfigLines);
}
function updateEthSenderConfig(validiumMode: boolean) {
    // This constant is used in validium mode and is deleted in rollup mode
    // In order to pass the existing integration tests
    const updatedConfigLines: ConfigLine[] = [
        {
            key: 'l1_gas_per_pubdata_byte',
            value: validiumMode ? constants.VALIDIUM_L1_GAS_PER_PUBDATA_BYTE : constants.ROLLUP_L1_GAS_PER_PUBDATA_BYTE,
            section: null
        }
    ];
    updateConfigFile(ETH_SENDER_PATH, updatedConfigLines);
}

function updateExtNodeConfig(validiumMode: boolean) {
    const updatedConfigLines: ConfigLine[] = [
        {
            key: 'l1_batch_commit_data_generator_mode',
            value: validiumMode ? 'Validium' : null,
            section: validiumMode ? 'en' : null
        }
    ];
    updateConfigFile(EXT_NODE_PATH, updatedConfigLines);
}

function updateConfig(validiumMode: boolean) {
    updateChainConfig(validiumMode);
    updateEthSenderConfig(validiumMode);
    updateExtNodeConfig(validiumMode);
    config.compileConfig();
    let envFileContent = fs.readFileSync(process.env.ENV_FILE!).toString();
    envFileContent += `VALIDIUM_MODE=${validiumMode}\n`;
    fs.writeFileSync(process.env.ENV_FILE!, envFileContent);
}

async function checkEnv() {
    const tools = ['node', 'yarn', 'docker', 'cargo'];
    for (const tool of tools) {
        await utils.exec(`which ${tool}`);
    }
    const { stdout: version } = await utils.exec('node --version');
    // Node v14.14 is required because
    // the `fs.rmSync` function was added in v14.14.0
    if ('v14.14' >= version) {
        throw new Error('Error, node.js version 14.14.0 or higher is required');
    }
}

export interface InitArgs {
    skipSubmodulesCheckout: boolean;
    skipEnvSetup: boolean;
    governorPrivateKeyArgs: any[];
    deployerPrivateKeyArgs: any[];
    deployerL2ContractInput: {
        args: any[];
        includePaymaster: boolean;
        includeL2WETH: boolean;
    };
    testTokens: {
        deploy: boolean;
        args: any[];
    };
    validiumMode: boolean;
}

const DEFAULT_ARGS: InitArgs = {
    skipSubmodulesCheckout: false,
    skipEnvSetup: false,
    governorPrivateKeyArgs: [],
    deployerPrivateKeyArgs: [],
    deployerL2ContractInput: { args: [], includePaymaster: true, includeL2WETH: true },
    testTokens: { deploy: true, args: [] },
    validiumMode: false
};

export const initCommand = new Command('init')
    .option('--skip-submodules-checkout')
    .option('--skip-env-setup')
    .option('--validium-mode')
    .description('perform zksync network initialization for development')
    .action(async (cmd: Command) => {
        const initArgs: InitArgs = {
            skipSubmodulesCheckout: cmd.skipSubmodulesCheckout,
            skipEnvSetup: cmd.skipEnvSetup,
            governorPrivateKeyArgs: [],
            deployerL2ContractInput: { args: [], includePaymaster: true, includeL2WETH: true },
            testTokens: { deploy: true, args: [] },
            deployerPrivateKeyArgs: [],
            validiumMode: cmd.validiumMode !== undefined ? cmd.validiumMode : false
        };
        await init(initArgs);
    });
export const reinitCommand = new Command('reinit')
    .description('"reinitializes" network. Runs faster than `init`, but requires `init` to be executed prior')
    .action(async (cmd: Command) => {
        await reinit(cmd.validiumMode);
    });
export const lightweightInitCommand = new Command('lightweight-init')
    .description('perform lightweight zksync network initialization for development')
    .action(async (cmd: Command) => {
        await lightweightInit(cmd.validiumMode);
    });
