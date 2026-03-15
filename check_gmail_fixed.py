# -*- coding: utf-8 -*-
import imaplib
import email
from email.header import decode_header
import json
import sys

# 设置输出编码
sys.stdout.reconfigure(encoding="utf-8")

IMAP_SERVER = "imap.gmail.com"
IMAP_PORT = 993
EMAIL_ADDRESS = "duketxl@gmail.com"
APP_PASSWORD = "lgue bwcf qbkg gjpa"

def decode_str(s):
    if s is None:
        return ""
    decoded_list = decode_header(s)
    result = ""
    for decoded_str, charset in decoded_list:
        if isinstance(decoded_str, bytes):
            try:
                result += decoded_str.decode(charset or "utf-8", errors="ignore")
            except:
                result += decoded_str.decode("utf-8", errors="ignore")
        else:
            result += str(decoded_str)
    return result

def get_priority_level(subject, sender):
    subject_lower = subject.lower()
    sender_lower = sender.lower()
    text = subject_lower + " " + sender_lower
    
    if any(k in text for k in ["security alert", "suspicious", "password changed", "login attempt", "unauthorized", "account locked", "urgent payment", "fraud alert", "verification"]):
        return "P0"
    if any(k in text for k in ["invoice", "payment due", "contract", "business proposal", "partnership", "system notification", "server down", "purchase order", "billing"]):
        return "P1"
    if any(k in text for k in ["meeting", "project update", "report", "schedule", "deadline", "review"]):
        return "P2"
    return "P3"

def get_mail_type(subject, sender):
    s = subject.lower()
    if any(k in s for k in ["security", "alert", "verify", "authentication", "advisory"]):
        return "Security Alert"
    elif any(k in s for k in ["system", "notification", "server"]):
        return "System Notification"
    elif any(k in s for k in ["invoice", "payment", "billing", "receipt", "subscription", "renews"]):
        return "Financial Payment"
    elif any(k in s for k in ["business", "cooperation", "contract", "proposal"]):
        return "Business Cooperation"
    elif any(k in s for k in ["meeting", "interview", "calendar"]):
        return "Meeting Schedule"
    else:
        return "General Email"

print("=" * 80)
print("GMAIL IMAP EMAIL CHECKER")
print("=" * 80)
print("Connecting to Gmail IMAP...")
mail = imaplib.IMAP4_SSL(IMAP_SERVER, IMAP_PORT)
print("Logging in...")
mail.login(EMAIL_ADDRESS, APP_PASSWORD)
print("Selecting inbox...")
mail.select("inbox")
print("Searching emails...")
status, messages = mail.search(None, "ALL")

if status != "OK":
    print("Search failed")
    exit(1)

email_ids = messages[0].split()
total = len(email_ids)
print(f"Total emails in inbox: {total}")

latest_10 = email_ids[-10:] if len(email_ids) >= 10 else email_ids
latest_10.reverse()
print(f"Fetching latest {len(latest_10)} emails")
print("=" * 80)

emails_list = []
important_alerts = []

for idx, email_id in enumerate(latest_10, 1):
    try:
        status, msg_data = mail.fetch(email_id, "(RFC822)")
        if status != "OK":
            continue
        raw_email = msg_data[0][1]
        msg = email.message_from_bytes(raw_email)
        
        uid = email_id.decode("utf-8")
        subject = decode_str(msg["Subject"])
        sender = decode_str(msg["From"])
        date_str = msg["Date"] or "N/A"
        priority_header = msg.get("X-Priority", msg.get("Priority", "N/A"))
        
        priority_level = get_priority_level(subject, sender)
        mail_type = get_mail_type(subject, sender)
        
        email_info = {
            "index": idx,
            "UID": uid,
            "from": sender,
            "subject": subject,
            "date": date_str,
            "header_priority": priority_header,
            "priority": priority_level,
            "type": mail_type
        }
        emails_list.append(email_info)
        if priority_level in ["P0", "P1"]:
            important_alerts.append(email_info)
        
        print(f"\n[Email {idx}]")
        print(f"  UID: {uid}")
        print(f"  From: {sender}")
        print(f"  Subject: {subject}")
        print(f"  Date: {date_str}")
        print(f"  Type: {mail_type}")
        print(f"  Priority: {priority_level}")
        print("-" * 60)
    except Exception as e:
        print(f"Error processing email {idx}: {e}")

mail.close()
mail.logout()

print("\n" + "=" * 80)
print("SUMMARY")
print("=" * 80)
print(f"Total fetched: {len(emails_list)}")

p0 = sum(1 for e in emails_list if e["priority"] == "P0")
p1 = sum(1 for e in emails_list if e["priority"] == "P1")
p2 = sum(1 for e in emails_list if e["priority"] == "P2")
p3 = sum(1 for e in emails_list if e["priority"] == "P3")

print(f"Priority: P0={p0}, P1={p1}, P2={p2}, P3={p3}")

if important_alerts:
    print("\n*** IMPORTANT ALERTS (P0/P1) ***")
    for a in important_alerts:
        prio = a["priority"]
        typ = a["type"]
        subj = a["subject"]
        print(f"  [{prio}] {typ} - {subj}")
else:
    print("\nNo P0/P1 priority alerts found.")

print("\n" + "=" * 80)
print("JSON OUTPUT")
print("=" * 80)
output = {
    "total_fetched": len(emails_list),
    "emails": emails_list,
    "important_alerts": important_alerts,
    "priority_summary": {"P0": p0, "P1": p1, "P2": p2, "P3": p3}
}
print(json.dumps(output, ensure_ascii=False, indent=2))

