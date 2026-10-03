# TooLang (specifically made for this project)
### made with love by befaci :) 

*(if using this, you can remove the read me safely, as the license says tho you can't change the license)*

Btw **at ANY moment this can be converted as an NPM package**

## Documentation

* [Syntax Reference](./docs/syntax.md) - variables, functions, control flow, expressions
* [Built-in Modules](./docs/builtins.md) - http, json, nodejs, docker, discord, agent, etc.
* [Examples](./examples/) - working .tl scripts

## Quick Start

```ts
import { executeTool } from "./utils/toolang/index.js";

const result = await executeTool("path/to/tool.tl", { command: "ls" }, {
  config: { // optional policy: http/fs/node/docker
    http: { blockPrivate: true },
    fs: { root: "./sandbox", allowWrite: false },
    node: { enabled: false },
    docker: { enabled: false },
  },
  limits: { maxSteps: 100_000 }, // optional overrides (get clamped)
});
console.log(result); // { success: true, data: ... }
```

With Discord.js and Agent context:

```ts
import { executeTool } from "./utils/toolang/index.js";

const result = await executeTool("discord_tool.tl", args, {
  discord: client,
  agent: myAgent,
});
```

The interpreter enforces hard limits (loop iterations, call depth, step
budget, output length, wall-clock timeout via the tool registry). Limit
violations cannot be caught by tool scripts with try/catch.

## Stuff to add from the license

* If making a fork, please keep the headers from all files in this folder, when making a file you don't have to credit me tho, if you edit a file you can add yourself but keep my name in it

If you modified something in here, feel free to contribute ! :D
