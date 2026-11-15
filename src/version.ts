import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION } from './protocol/index.ts';
import { AGENT_SDK_VERSION, TETHER_VERSION } from './threads/LiveThread.ts';

/**
 * What `tether version --json` prints, for a person checking a host and for the release workflow's
 * smoke run of the built npm package (`npm.yml`). No client probes it: the app runs a pinned
 * `tether-server@<version> connect` and the handshake settles protocol compatibility. `platform` is
 * this machine's `<os>-<arch>` (`darwin-arm64`, `linux-x64`, …), for information only.
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
