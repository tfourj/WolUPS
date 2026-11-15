# Versioning

The server and the agent have separate versions and releases. Both use `X.Y.Z`.

| Component    | Tag            | Publishes                                                         |
| ------------ | -------------- | ----------------------------------------------------------------- |
| Server + UI  | `vX.Y.Z`       | `ghcr.io/tfourj/wolups` image (amd64, arm64) and a GitHub release |
| Agent        | `agent-vX.Y.Z` | GitHub release with agent binaries, install scripts and checksums |

```bash
git tag -a v1.2.3 -m "WolUPS v1.2.3" && git push origin v1.2.3
git tag -a agent-v1.2.3 -m "WolUPS agent v1.2.3" && git push origin agent-v1.2.3
```

- Agent releases are always the repository's **latest** release. Installs, agent updates and the server's update
  check all read `releases/latest/download`. Server releases are never marked latest, so do not mark them latest
  by hand.
- Agent and server versions do not need to match. The agent's `protocol_version` in `agent-release.json` decides
  compatibility, and the server ignores agent releases with a different protocol.
- Releases up to `v0.1.2` shipped both together. Agent versions continue from there.
- Server builds of a commit without a `vX.Y.Z` tag show the short commit instead of a version.
