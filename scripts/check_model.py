#!/usr/bin/env python3
"""Stdlib-only smoke check: does the configured provider return a function_call?
Reads .env (KEY=VALUE, env vars override), sends ONE Responses API request with
a trivial tool, and prints PASS/FAIL. Never prints the API key.
"""
import json,os,sys,time,urllib.error,urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
DEFAULT_ENDPOINT='https://api.flower.ai/v1/responses'
PING_TOOL={'type':'function','name':'ping','description':'Trivial check tool; call it with no arguments.',
    'parameters':{'type':'object','properties':{},'additionalProperties':False,'required':[]}}


def parse_env_file(path):
    env={}
    if not path.exists():return env
    for line in path.read_text().splitlines():
        line=line.strip()
        if not line or line.startswith('#') or '=' not in line:continue
        key,_,value=line.partition('=')
        env[key.strip()]=value.strip().strip('"').strip("'")
    return env


def load_config(env_path=None,environ=None):
    env=parse_env_file(env_path or ROOT/'.env')
    env.update(environ if environ is not None else os.environ)
    endpoint=env.get('FLWR_MODEL_API_ENDPOINT','').strip() or DEFAULT_ENDPOINT
    key=env.get('FLWR_MODEL_API_KEY','').strip()
    model=env.get('INVESTIGATOR_MODEL','').strip()
    return endpoint,key,model


def check(endpoint,key,model,timeout=90):
    """Return (ok, reason, elapsed_seconds). Never includes the key in the reason."""
    body=json.dumps({'model':model,'input':[{'role':'user','content':'Call ping once with no arguments.'}],
        'tools':[PING_TOOL],'tool_choice':{'type':'function','name':'ping'},'max_output_tokens':512}).encode()
    headers={'Content-Type':'application/json','User-Agent':'slac-investigator-check'}  # Groq's edge 403s the default Python-urllib agent
    if key:headers['Authorization']='Bearer '+key
    request=urllib.request.Request(endpoint,data=body,headers=headers,method='POST')
    started=time.perf_counter()
    try:
        with urllib.request.urlopen(request,timeout=timeout) as response:
            payload=json.loads(response.read())
        calls=[item for item in payload.get('output',[]) if item.get('type')=='function_call']
    except urllib.error.HTTPError as e:
        return False,f'HTTP {e.code} from provider',time.perf_counter()-started
    except Exception as e:
        return False,f'{type(e).__name__}: {e}',time.perf_counter()-started
    if not calls:
        return False,'Response contained no function_call',time.perf_counter()-started
    return True,f'Received function_call {calls[0].get("name","")!r}',time.perf_counter()-started


def main():
    endpoint,key,model=load_config()
    if not model:
        print('FAIL: INVESTIGATOR_MODEL is not set (check .env)')
        return 1
    ok,reason,elapsed=check(endpoint,key,model)
    print(f'{"PASS" if ok else "FAIL"}: {reason} ({elapsed:.2f}s, endpoint={endpoint}, model={model})')
    return 0 if ok else 1


if __name__=='__main__':
    sys.exit(main())
