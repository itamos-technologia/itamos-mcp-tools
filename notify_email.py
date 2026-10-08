#!/usr/bin/env python3
"""Send one plain-text email for the sandbox server (standard library only).

Reads a JSON object {"to", "subject", "body"} from stdin and sends it from the
account in the credentials file (SMTP with STARTTLS). The credentials file is
SANDBOX_SMTP_CREDENTIALS, or the shared Itamos mail credentials by default:
  {"email", "app_password", "smtp_server", "smtp_port"}
Exit code 0 on success, 1 on any failure. Never prints the recipient address.
"""
import json
import os
import smtplib
import sys
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

DEFAULT_CREDS = "/tank/projects/mcp-servers/tools/email/credentials/itamos_imap.json"


def main():
    try:
        job = json.load(sys.stdin)
        with open(os.environ.get("SANDBOX_SMTP_CREDENTIALS", DEFAULT_CREDS)) as f:
            creds = json.load(f)
        msg = EmailMessage()
        msg["From"] = formataddr(("Itamos MCP Sandbox", creds["email"]))
        msg["To"] = job["to"]
        msg["Subject"] = job["subject"]
        msg["Message-ID"] = make_msgid(domain=creds["email"].split("@")[1])
        msg.set_content(job["body"])
        with smtplib.SMTP(creds["smtp_server"], int(creds.get("smtp_port", 587)), timeout=20) as s:
            s.starttls()
            s.login(creds["email"], creds["app_password"])
            s.send_message(msg)
        return 0
    except Exception as e:
        # Only the error type: SMTP error texts can contain the recipient address.
        print(f"send failed: {type(e).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
