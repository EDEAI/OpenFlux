# -*- coding: utf-8 -*-
import imaplib
import email
from email.header import decode_header
import json
import sys
import datetime

sys.stdout.reconfigure(encoding="utf-8")

print("=" * 80)
print("GMAIL IMAP - REAL EMAIL RETRIEVAL")
print("=" * 80)
print(f"Time: {datetime.datetime.now()}")
print(f"Python: {sys.version}")
print("-" * 80)

IMAP_SERVER = "imap.gmail.com"
IMAP_PORT = 993
EMAIL_ADDRESS = "duketxl@gmail.com"
APP_PASSWORD = "lgue bwcf qbkg gjpa"

print(f"\n[1] Connecting to {IMAP_SERVER}:{IMAP_PORT}...")
mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
print(f"    Connected: {mail.welcome}")

print(f"\n[2] Authenticating...")
mail.login(EMAIL_ADDRESS, APP_PASSWORD)
print(f"    Logged in as {EMAIL_ADDRESS}")

print(f"\n[3] Selecting inbox...")
status, data = mail.select("inbox")
print(f"    Status: {status}, Messages: {data[0].decode()}")

print(f"\n[4] Searching...")
status, messages = mail.search(None, "ALL")
email_ids = messages[0].split()
total = len(email_ids)
print(f"    Found {total} emails")

latest_10 = email_ids[-10:] if len(email_ids) >= 10 else email_ids
latest_10.reverse()
print(f"\n[5] Fetching {len(latest_10)} latest emails...")
print("=" * 80)

emails_list = []

def decode_str(s):
    if s is None: return ""
    decoded_list = decode_header(s)
    result = ""
    for decoded_str, charset in decoded_list:
        if isinstance(decoded_str, bytes):
            try: result += decoded_str.decode(charset or "utf-8", errors="ignore")
            except: result += decoded_str.decode("utf-8", errors="ignore")
        else: result += str(decoded_str)
    return result

for idx, email_id in enumerate(latest_10, 1):
    try:
        status, msg_data = mail.fetch(email_id, "(RFC822)")
        if status != "OK": continue
        raw_email = msg_data[0][1]
        msg = email.message_from_bytes(raw_email)
        uid = email_id.decode("utf-8")
        subject = decode_str(msg["Subject"])
        sender = decode_str(msg["From"])
        date_str = msg["Date"] or "N/A"
        priority_header = msg.get("X-Priority", msg.get("Priority", "N/A"))
        s_lower = subject.lower()
        mail_type = "General Email"
        if any(k in s_lower for k in ["security", "alert", "advisory"]): mail_type = "Security Alert"
        elif any(k in s_lower for k in ["payment", "invoice", "billing", "subscription", "renews"]): mail_type = "Financial Payment"
        elif any(k in s_lower for k in ["system", "notification", "server"]): mail_type = "System Notification"
        elif any(k in s_lower for k in ["business", "contract", "cooperation"]): mail_type = "Business Cooperation"
        emails_list.append({"index": idx, "UID": uid, "from": sender, "subject": subject, "date": date_str, "header_priority": priority_header, "priority": "P3", "type": mail_type})
    except Exception as e:
        print(f"Error on {idx}: {e}")

mail.close()
mail.logout()

print(f"\nRetrieved {len(emails_list)} emails")
print("\n" + "=" * 80)
print("EMAIL DATA:")
print("=" * 80)
for e in emails_list:
    print(f"\n[{e[chr(39)+chr(39)]index{chr(39)+chr(39)]}] UID: {e[chr(39)+chr(39)]UID{chr(39)+chr(39)]}")
    print(f"    From: {e[chr(39)+chr(39)]from{chr(39)+chr(39)]}")
    print(f"    Subject: {e[chr(39)+chr(39)]subject{chr(39)+chr(39)]}")
    print(f"    Date: {e[chr(39)+chr(39)]date{chr(39)+chr(39)]}")
    print(f"    Type: {e[chr(39)+chr(39)]type{chr(39)+chr(39)]}")
print("\n" + "=" * 80)
print("JSON:")
print("=" * 80)
print(json.dumps({"verified": True, "timestamp": str(datetime.datetime.now()), "inbox_total": total, "fetched": len(emails_list), "emails": emails_list}, indent=2, ensure_ascii=False))
