/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { SomniaAgentKit, SOMNIA_NETWORKS } from "somnia-agent-kit";
import { logger } from "../utils/logger.js";

export interface AgentRegistrationParams {
  name: string;
  description: string;
  ipfsHash?: string;
  capabilities: string[];
}

export interface AgentInfo {
  id: number;
  name: string;
  description: string;
  owner: string;
  isActive: boolean;
  capabilities?: string[];
}

const TESTNET_CONTRACTS = {
  agentRegistry: "0xC9f3452090EEB519467DEa4a390976D38C008347",
  agentManager: "0x77F6dC5924652e32DBa0B4329De0a44a2C95691E",
  agentExecutor: "0x157C56dEdbAB6caD541109daabA4663Fc016026e",
  agentVault: "0x7cEe3142A9c6d15529C322035041af697B2B5129",
};

export async function makeAgentKit(network: "testnet" | "mainnet" = "testnet"): Promise<SomniaAgentKit> {
  if (network === "mainnet") {
    throw new Error(
      "Mainnet contracts for somnia-agent-kit not yet published. Register on testnet for demonstration.",
    );
  }
  const kit = new SomniaAgentKit({
    network: SOMNIA_NETWORKS.testnet,
    contracts: TESTNET_CONTRACTS,
    privateKey: process.env.PRIVATE_KEY,
  });
  await kit.initialize();
  return kit;
}

export async function registerAgent(
  params: AgentRegistrationParams,
  network: "testnet" | "mainnet" = "testnet",
): Promise<{ txHash: string; agentId?: number }> {
  const kit = await makeAgentKit(network);

  logger.info(
    {
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      network,
    },
    "Registering Somnia Agent on-chain",
  );

  const tx = await kit.contracts.registry.registerAgent(
    params.name,
    params.description,
    params.ipfsHash ?? "",
    params.capabilities,
  );
  const receipt = await tx.wait();
  logger.info({ txHash: receipt?.hash, status: receipt?.status }, "Agent registered");

  // Try to read latest agent ID
  let agentId: number | undefined;
  try {
    const total = await kit.contracts.registry.getTotalAgents();
    agentId = Number(total);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not fetch agentId");
  }

  return { txHash: receipt?.hash ?? "", agentId };
}

export async function getAgentInfo(
  agentId: number,
  network: "testnet" | "mainnet" = "testnet",
): Promise<AgentInfo> {
  const kit = await makeAgentKit(network);
  const agent = await kit.contracts.registry.getAgent(agentId);
  return {
    id: agentId,
    name: agent.name,
    description: agent.description ?? "",
    owner: agent.owner,
    isActive: agent.isActive,
  };
}

export async function listAgents(network: "testnet" | "mainnet" = "testnet"): Promise<{ total: number }> {
  const kit = await makeAgentKit(network);
  const total = await kit.contracts.registry.getTotalAgents();
  return { total: Number(total) };
}
