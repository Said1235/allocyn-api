#!/usr/bin/env node
import { run } from "./run.ts";

run(process.argv.slice(2), { fetch, out: (s) => console.log(s), err: (s) => console.error(s), env: process.env })
  .then((code) => { process.exitCode = code; });
