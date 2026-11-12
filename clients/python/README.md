# Allocyn API client for Python

One file, standard library only, read-only. Generated from the API's route table by `node scripts/gen-python-client.mjs`, so it has a method for every route.

```python
from allocyn_api import AllocynApi, AllocynApiError

api = AllocynApi("https://your-project.vercel.app", consistency="final")
job = api.get_job("job-1")
page = api.list_jobs(status="VERIFIED", limit=10)
proof = api.get_job_proof("job-1")
try:
    api.get_job("job-999")
except AllocynApiError as e:
    print(e.code, e.retryable)   # JOB_NOT_FOUND False
```

Copy `allocyn_api.py` into your project, or add this folder to `PYTHONPATH`. It is not published to PyPI. Python 3.8 or newer. It cannot write: writes are signed by the participant's own wallet with `@allocyn/sdk`.
