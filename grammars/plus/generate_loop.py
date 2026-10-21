"""Run build_plus.sh; when generation stops on an unresolved conflict whose suggested fix is
'Add a conflict for these rules', record that conflict in extra_conflicts.json and retry
(at most MAX times). Prints every conflict added, so each one can be reviewed.
   python3 generate_loop.py NAME BASE_GRAMMAR_JS BASE_SCANNER_C"""
import json, re, subprocess, sys, os

MAX = 12
here = os.path.dirname(os.path.abspath(__file__))
cf = os.path.join(here, "extra_conflicts.json")
conf = json.load(open(cf)) if os.path.exists(cf) else []
for i in range(MAX):
    r = subprocess.run(["bash", os.path.join(here, "build_plus.sh"), *sys.argv[1:4]],
                       capture_output=True, text=True)
    out = r.stdout + r.stderr
    if r.returncode == 0:
        print(out.strip().splitlines()[-1])
        print("conflicts now:", json.dumps(conf))
        sys.exit(0)
    m = re.search(r"Add a conflict for these rules: (.+)", out)
    if not m:
        print(out[-3000:])
        sys.exit(1)
    rules = re.findall(r"`([^`]+)`", m.group(1))
    if rules in conf:
        print("conflict already added, generation still fails:\n", out[-3000:])
        sys.exit(1)
    seq = re.search(r"Unresolved conflict for symbol sequence:\s*\n\s*\n\s*(.+)", out)
    print(f"adding conflict {rules}   for: {seq.group(1).strip() if seq else '?'}")
    conf.append(rules)
    json.dump(conf, open(cf, "w"))
print("gave up after", MAX)
sys.exit(1)
