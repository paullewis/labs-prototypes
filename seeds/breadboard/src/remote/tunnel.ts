/**
 * @license
 * Copyright 2023 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { callHandler } from "../handler.js";
import {
  InputValues,
  Kit,
  NodeHandlerContext,
  NodeHandlers,
  NodeTypeIdentifier,
  NodeValue,
  OutputValues,
} from "../types.js";
import {
  ProxyServerConfig,
  TunnelDestinations,
  TunnelInputs,
  TunnelSpec,
} from "./config.js";

/**
 * All tunnels defined for a particular node (the tunnel entry).
 */
export type NodeTunnels = {
  [outputName: string]: NodeTunnel[];
};

/**
 * The map of the entire network of tunnels for all nodes.
 */
export type TunnelMap = {
  [node: NodeTypeIdentifier]: NodeTunnels;
};

export type DestinationTunnels = {
  [inputName: string]: NodeTunnel;
};

export type TunnelDestinationMap = {
  [destinationNode: NodeTypeIdentifier]: DestinationTunnels;
};

export class NodeTunnel implements TunnelDestinations {
  constructor(
    readonly outputName: string,
    readonly from: NodeTypeIdentifier,
    readonly to: NodeTypeIdentifier,
    readonly inputs: TunnelInputs = {}
  ) {}

  getInputNames() {
    const inputNames = Object.keys(this.inputs);
    return inputNames.length === 0 ? [this.outputName] : inputNames;
  }

  matches(inputs: InputValues) {
    return Object.entries(this.inputs).every(([inputName, value]) => {
      const inputValue = inputs[inputName];
      if (typeof value === "string") {
        return inputValue === value;
      } else {
        if (typeof inputValue !== "string") return false;
        return value.test(inputValue);
      }
    });
  }
}

export const readConfig = (config: ProxyServerConfig): TunnelMap => {
  if (!config.proxy) return {};
  return Object.fromEntries(
    config.proxy
      .map((spec) => {
        if (typeof spec === "string") {
          return undefined;
        }
        if (!spec.tunnel) return undefined;
        return [spec.node, readNodeSpec(spec.node, spec.tunnel)];
      })
      .filter(Boolean) as [NodeTypeIdentifier, NodeTunnels][]
  );
};

export const readNodeSpec = (
  node: NodeTypeIdentifier,
  spec: TunnelSpec
): NodeTunnels => {
  return Object.fromEntries(
    Object.entries(spec).map(([outputName, value]) => {
      if (typeof value === "string") {
        return [outputName, [new NodeTunnel(outputName, node, value)]];
      } else if (Array.isArray(value)) {
        return [
          outputName,
          value.map((v) => {
            if (typeof v === "string") {
              return new NodeTunnel(outputName, node, v);
            }
            return new NodeTunnel(outputName, node, v.to, v.inputs);
          }),
        ];
      } else {
        return [
          outputName,
          [new NodeTunnel(outputName, node, value.to, value.inputs)],
        ];
      }
    })
  );
};

type OutputReplacer = (outputName: string, outputValue: NodeValue) => NodeValue;

export const replaceOutputs = (
  outputs: void | OutputValues,
  tunnels: NodeTunnels,
  replacer: OutputReplacer
): void | OutputValues => {
  if (!outputs) return;
  return Object.fromEntries(
    Object.entries(outputs).map(([outputName, value]) => {
      return outputName in tunnels
        ? [outputName, replacer(outputName, value)]
        : [outputName, value];
    })
  );
};

type InputReplacer = (
  inputValue: NodeValue,
  allow: boolean
) => Promise<NodeValue>;

export const replaceInputs = async (
  inputs: InputValues,
  tunnels: DestinationTunnels,
  replacer: InputReplacer
) => {
  // Decide if we should allow or block values for this node.
  const allow = Object.values(tunnels).some((tunnel) => tunnel.matches(inputs));

  return Object.fromEntries(
    await Promise.all(
      Object.entries(inputs).map(async ([inputName, value]) => {
        return [inputName, await replacer(value, allow)];
      })
    )
  );
};

// Compute a simple hash that expires every 7 days.
// The point of this hash is not protect anything, but rather to have
// a simple way to identify a tunnelled value.
// It is also rotating so that the users of the node proxy don't accidentally
// adopt bad practices of hard-coding the values.
// Note: the rotation will occasionaly cause errors at the break of the week.
// TODO: Fix the rotation to be window-based or come up with an even better
// solution.
const TUNNEL_HASH = Math.round(Date.now() / 1000 / 60 / 60 / 7).toString(36);
const TUNNEL_PREFIX = `T-${TUNNEL_HASH}-`;
const TUNNEL_SUFFIX = `-${TUNNEL_HASH}-T`;
const SPLIT_REGEX = new RegExp(`(${TUNNEL_PREFIX}.*?${TUNNEL_SUFFIX})`, "gm");
const TUNNEL_REGEX = new RegExp(`^${TUNNEL_PREFIX}(.+?)${TUNNEL_SUFFIX}$`);
const BLOCKED_TUNNEL_VALUE = "VALUE_BLOCKED";

export const getTunnelValue = (
  nodeType: NodeTypeIdentifier,
  outputName: string,
  inputs: InputValues
) => {
  const memoize = JSON.stringify(inputs);
  return `${TUNNEL_PREFIX}${nodeType}$${outputName}$${memoize}${TUNNEL_SUFFIX}`;
};

type TunnelScanResult = (
  | {
      value: string;
    }
  | {
      nodeType: NodeTypeIdentifier;
      outputName: string;
      inputs: string;
    }
)[];

export const scanTunnelValue = (value: string): TunnelScanResult => {
  const parts = value.split(SPLIT_REGEX).filter(Boolean);
  return parts.map((part) => {
    const match = part.match(TUNNEL_REGEX);
    if (match) {
      // This is a tunnel value, parse it into components and return
      // a helper object that enables the caller to replace the value.
      const [nodeType, outputName, inputs] = match[1].split("$");
      return {
        nodeType,
        outputName,
        inputs,
      };
    } else {
      // This is a regular substring, return a helper object that handles
      // joining it back together as a string.
      return {
        value: part,
      };
    }
  });
};

type TunnelValueReplacer = (
  nodeType: NodeTypeIdentifier,
  inputs: InputValues
) => Promise<void | OutputValues>;

export const replaceTunnelledInputs = async (
  input: NodeValue,
  /**
   * If true, the tunneled inputs will be replaced with the original value.
   * If false, the tunneled inputs should be blocked. The tunnel value
   * is replaced with a BLOCKED_TUNNEL_VALUE.
   */
  allow: boolean,
  replacer: TunnelValueReplacer
) => {
  const json = JSON.stringify(input);
  const parts = scanTunnelValue(json);

  const result = await Promise.all(
    parts.map(async (part) => {
      if ("inputs" in part) {
        const inputs = JSON.parse(JSON.parse(`"${part.inputs}"`));
        const { nodeType, outputName } = part;
        const outputs = allow
          ? await replacer(nodeType, inputs)
          : { [outputName]: BLOCKED_TUNNEL_VALUE };
        if (!outputs) return "";
        let jsonString = JSON.stringify(outputs[outputName]);
        if (jsonString.startsWith('"')) {
          jsonString = jsonString.slice(1, -1);
        }
        jsonString = JSON.stringify(jsonString);
        return jsonString.slice(1, -1);
      }
      return part.value;
    })
  );
  return JSON.parse(result.join(""));
};

export const createDestinationMap = (map: TunnelMap): TunnelDestinationMap => {
  // pivot the map of tunnel entries to create a map of tunnel destinations
  const entries = Object.entries(map).flatMap(([_, nodeTunnels]) => {
    return Object.entries(nodeTunnels).flatMap(([_, tunnels]) => {
      return tunnels.map((tunnel) => {
        return [tunnel.to, tunnel];
      });
    });
  }) as [NodeTypeIdentifier, NodeTunnel][];
  // collate entries by destination node
  return entries.reduce((acc, [to, tunnel]) => {
    if (!acc[to]) acc[to] = {};
    for (const inputName of tunnel.getInputNames()) {
      // TODO: What to do about tunnel destination collisions?
      // At this point, let's just throw an exception.
      if (acc[to][inputName]) {
        throw new Error(
          `Tunnel destination collision: ${to}.${inputName} is already occupied by ${acc[to][inputName].from}.${acc[to][inputName].outputName}`
        );
      }
      acc[to][inputName] = tunnel;
    }
    return acc;
  }, {} as Record<NodeTypeIdentifier, Record<NodeTypeIdentifier, NodeTunnel>>);
};

/**
 * A special kit that provides tunneling of outputs and inputs as specified
 * by the Tunnels spec.
 *
 * This kit is constructed from existing NodeHandlers and the Tunnels spec.
 * It reads the spec and wraps the node handlers to add the tunneling logic.
 *
 * The tunnel entries, or the outputs of nodes that are tunneled, are replaced
 * with a special value that is computed from the node type and the output name.
 *
 * The tunnel destinations, or the inputs of the nodes to which a tunnel leads, are
 * replaced with the original value of the tunnel entry.
 */
export const createTunnelKit = (
  map: TunnelMap,
  handlers: NodeHandlers
): Kit => {
  // wrap handlers to tunnel outputs (tunnel entries)
  const outputWrappedHandlers = Object.fromEntries(
    Object.entries(handlers).map(([nodeType, handler]) => {
      const nodeTunnels = map[nodeType];
      if (!nodeTunnels) return [nodeType, handler];
      return [
        nodeType,
        async (inputs: InputValues, context: NodeHandlerContext) => {
          const outputs = await callHandler(handler, inputs, context);
          return replaceOutputs(outputs, nodeTunnels, (name) =>
            getTunnelValue(nodeType, name, inputs)
          );
        },
      ];
    })
  );

  // wrap handlers to connect the tunnel to the inputs (tunnel destinations)
  const destinations = createDestinationMap(map);
  const inputWrappedHandlers = Object.fromEntries(
    Object.entries(outputWrappedHandlers).map(([nodeType, handler]) => {
      const destinationTunnels = destinations[nodeType];
      if (!destinationTunnels) return [nodeType, handler];
      return [
        nodeType,
        async (inputs: InputValues, context: NodeHandlerContext) => {
          return callHandler(
            handler,
            await replaceInputs(
              inputs,
              destinationTunnels,
              async (value, allow) => {
                // scan for tunneled values in `value`.
                // for each found `tunnel value`,
                // - extract the node type and output name of the tunnel entry.
                // - call the handler of the node type for the tunnel entry
                //   with the inputs that are decoded from the tunnel value
                // - from the outputs, extract the inputs that are tunneled
                //   and replace the `tunnel value` with them.
                return replaceTunnelledInputs(
                  value,
                  allow,
                  async (nodeType, inputs) => {
                    return callHandler(handlers[nodeType], inputs, context);
                  }
                );
              }
            ),
            context
          );
        },
      ];
    })
  );

  return {
    url: "tunnel-kit",
    handlers: inputWrappedHandlers,
  };
};