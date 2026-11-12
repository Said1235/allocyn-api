# @allocyn/cli

Read Allocyn jobs, receipts, proofs and badges from a terminal or a script. It talks to a deployed Allocyn API over HTTP, has no dependencies and cannot write.

```bash
export ALLOCYN_API_URL=https://your-project.vercel.app
allocyn job job-1
allocyn jobs --status VERIFIED --limit 5
allocyn proof job-1
allocyn wait job-1            # prints the job and its version
allocyn wait job-1 --since <version>   # returns when the job changes
allocyn badge job-1 --url     # the URL to put in a README
```

Answers go to standard output as JSON (`--envelope` keeps `{ success, data }`). Errors go to standard error. Exit codes: `0` ok, `1` the API answered with an error, `2` wrong usage, `3` the API could not be reached.

There is no default API address: point it at your own deployment. `http://` is only accepted for `localhost`.

From this repository: `npm run build -w @allocyn/cli`, then `node packages/cli/dist/cli.js --help`.
