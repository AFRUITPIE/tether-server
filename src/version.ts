import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from './protocol/index.ts';
import { AGENT_SDK_VERSION, TETHER_VERSION } from './threads/LiveThread.ts';

/**
 * What `tether version --json` prints: enough for a client to decide, before connecting, whether
 * the host's server will talk to it or needs installing or updating. `platform` names the release
 * asset for this machine (`darwin-arm64`, `linux-x64`, …).
 */
export function versionInfo() {
  return {
    version: TETHER_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    minClientProtocol: MIN_CLIENT_PROTOCOL,
    agentSdkVersion: AGENT_SDK_VERSION,
    platform: `${process.platform}-${process.arch}`,
  };
}
