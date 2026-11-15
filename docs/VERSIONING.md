# Versioning

The server and each agent have separate versions and releases. All use `X.Y.Z`.

| Component   | Tag                | Publishes                                                         |
| ----------- | ------------------ | ----------------------------------------------------------------- |
| Server + UI | `vX.Y.Z`           | `ghcr.io/tfourj/wolups` image (amd64, arm64) and a GitHub release |
| Agent       | `agent-vX.Y.Z`     | GitHub release with agent binaries, install scripts and checksums |
| NUT agent   | `nut-agent-vX.Y.Z` | Same for `wolups-nut-agent` (amd64, arm64, armv7)                 |

```bash
git tag -a v1.2.3 -m "WolUPS v1.2.3" && git push origin v1.2.3
git tag -a agent-v1.2.3 -m "WolUPS agent v1.2.3" && git push origin agent-v1.2.3
git tag -a nut-agent-v1.2.3 -m "WolUPS NUT agent v1.2.3" && git push origin nut-agent-v1.2.3
```

- Server releases are the repository's **latest** release. Agent releases never are.
- Installs, agent updates and the server's update check use the newest `agent-vX.Y.Z` or `nut-agent-vX.Y.Z`
  release, found through the GitHub API.
- Agents older than 0.1.4 update from the latest release and cannot update once a server release is latest. Rerun
  the install command without `--token` to upgrade them.
- Agent and server versions do not need to match. The agent's `protocol_version` in `agent-release.json` decides
  compatibility, and the server ignores agent releases with a different protocol.
- Releases up to `v0.1.2` shipped both together. Agent versions continue from there.
- Server builds of a commit without a `vX.Y.Z` tag show the short commit instead of a version.
