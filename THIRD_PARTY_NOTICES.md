# Third-party notices

## DeepSeek Harness

Source: https://github.com/deepseek-ai/deepseek-harness

Copyright (c) 2026 DeepSeek. Licensed under the MIT License.

The preset composition is based on the built-in Minimal and Standard presets.

## dsh-anchored-standard

Source: https://github.com/xiaobright/dsh-anchored-standard

Copyright (c) 2026 xiaobright. Portions copyright (c) 2026 DeepSeek.
Licensed under the MIT License.

The bootstrap, compaction epoch, instruction hint, and on-demand skill loader
are adapted from upstream commits
`4c529273f147083c64632f787f4c4f5303888926` and
`15a99b88a6862e7e0e503d14b0638caa27d14eaa`. That upstream preset derives
from DeepSeek Harness commit
`47f943859bef60e4160492346772ded9b24f765a`. Local changes add adaptive
routing, delegated-worker fast tracking, bounded skill loading, and
compaction-epoch fixes.

## Runtime dependencies

The installer requests these independent MIT-licensed profile plugins:

- dsh-agent-teams: https://github.com/NanmiCoder/dsh-agent-teams

They are not copied into this repository.
