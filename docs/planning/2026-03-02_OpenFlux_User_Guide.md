# OpenFlux User Guide

**Created:** 2026-03-02  
**Last Updated:** 2026-03-03  
**Author:** Development Team  
**Status:** Published  
**Version:** v0.1.6

## Overview

This guide is written for end users of OpenFlux. It explains everyday usage, features, and practical tips in plain language — no technical knowledge required.

## Changelog

| Date | Version | Changes | Author |
|------|---------|---------|--------|
| 2026-03-03 | v1.0 | Initial English version | Development Team |

---

## Table of Contents

1. [Getting Started: Setup Wizard](#1-getting-started-setup-wizard)
2. [Interface Overview](#2-interface-overview)
3. [Chat & Conversation](#3-chat--conversation)
4. [Smart Agents](#4-smart-agents)
5. [Scheduled Tasks](#5-scheduled-tasks)
6. [Workflows](#6-workflows)
7. [Learning Skills](#7-learning-skills)
8. [Long-Term Memory](#8-long-term-memory)
9. [Voice Interaction](#9-voice-interaction)
10. [Browser Automation](#10-browser-automation)
11. [File Preview & Artifacts](#11-file-preview--artifacts)
12. [Settings Panel](#12-settings-panel)
13. [Cloud & Remote Control](#13-cloud--remote-control)
14. [Tips & Best Practices](#14-tips--best-practices)
15. [FAQ](#15-faq)

---

## 1. Getting Started: Setup Wizard

When you launch OpenFlux for the first time, a 4-step setup wizard will guide you through the initial configuration.

### Step 1: AI Assistant

- **Assistant Name**: Give your AI a name (e.g., "Jarvis", "Alex"). It will use this name when you ask "who are you?"
- **Persona (optional)**: Describe your AI's personality (e.g., "You are a patient and detail-oriented personal assistant"). Leave blank to use the default persona.

### Step 2: AI Brain

- Choose a **model provider** (e.g., Moonshot, DeepSeek, OpenAI, etc.)
- Enter the provider's **API Key**
- Select a specific **model** (e.g., Kimi K2.5, DeepSeek Chat, etc.)

> 💡 **Recommended for beginners**: Use Moonshot (Kimi K2.5) — generous free tier, easy to set up.

### Step 3: Enterprise Connection (Optional)

If your team uses the NexusAI cloud platform, enter your credentials here. Skipping this has no impact on functionality.

### Step 4: Remote Control (Optional)

Enable this to interact with your AI via Feishu/Lark, WeChat, etc. You can always configure this later in Settings.

> All these settings can be changed anytime in the Settings panel after installation.

---

## 2. Interface Overview

```
┌────────────────────────────────────────────┐
│  Title Bar: Status · Artifacts · Theme      │
├──────┬─────────────────────────────────────┤
│      │                                     │
│ Side │       Chat Area                     │
│ bar  │  (Messages, tool call progress)     │
│      │                                     │
│      ├─────────────────────────────────────┤
│ Ses- │  Input Box: Text · Voice · File Drop │
│ sions│                                     │
│      ├─────────────────────────────────────┤
│ Tasks│  Debug Panel (optional)              │
│ Set. │                                     │
└──────┴─────────────────────────────────────┘
```

### Sidebar

- **New Chat** (➕): Start a new conversation
- **Session List**: All history, grouped by "Today / Yesterday / Earlier"
- **Search**: Search through past conversations
- **Scheduled Tasks** (⏰): View and manage scheduled tasks
- **Settings** (⚙️): Open the settings panel

### Title Bar

- **Status Light**: Shows "Ready", "Connecting", "Thinking", etc.
- **Artifacts Panel** (📎): Browse all files the AI has generated
- **Theme Toggle** (🌙): Switch between light / dark mode

---

## 3. Chat & Conversation

### Basic Chat

Type your message in the input box at the bottom and press Enter or click Send.

**Example conversations:**

| Scenario | Example |
|----------|---------|
| Knowledge Q&A | "What is quantum computing?" |
| Translation | "Translate this paragraph to French" |
| Writing | "Write me a cover letter for a software engineer position" |
| Analysis | "Analyze the trends in this data" |

### Sending Images

**Drag and drop** an image into the chat area to send it. The AI can recognize and analyze image content (requires a multimodal model like Claude, GPT-4o, or Kimi K2.5).

### Message Actions

Each message has quick action buttons:

- **Copy**: Copy the message content
- **Read Aloud** (🔊): Have the AI read this reply using voice
- **Retry**: Regenerate this reply
- **Stop**: Interrupt the AI while it's generating

### Code Blocks

Code in AI replies is automatically syntax-highlighted. Click "Copy Code" at the top-right corner of any code block to copy.

---

## 4. Smart Agents

OpenFlux has 3 built-in smart assistants and **automatically selects** the best one based on your question:

### General Assistant

Best for: casual chat, knowledge Q&A, translation, advice

**Examples:**
- "Explain the theory of relativity"
- "Recommend some sci-fi novels"
- "Translate this English text to Chinese"

### Coding Assistant

Best for: writing code, file operations, running scripts, generating documents

**Examples:**
- "Write a Python web scraper script"
- "Convert this CSV file to Excel"
- "Create a new project in D:\project"
- "Generate a Word daily report"

### Automation Assistant

Best for: browser tasks, desktop control, scheduled tasks

**Examples:**
- "Search for mechanical keyboards on Amazon"
- "Check my email every morning at 9 AM"
- "Open a browser and search today's weather"

### Manually Selecting an Agent

Use the `@` syntax to specify which assistant handles your request:

```
@coder Write a sorting function
@automation Open Google and search for news
```

### Customizing Persona

In **Settings → Agent** you can:

- **Change the assistant name**: e.g., rename to "Jarvis"
- **Set a global persona**: Define personality and behavior rules for all agents
- **Assign independent models**: e.g., use a cheap model for the general assistant and a powerful one for coding

---

## 5. Scheduled Tasks

You can create scheduled tasks using natural language — the AI sets them up and runs them automatically.

### Creating Scheduled Tasks

Just tell the AI what you need:

| You say | AI creates |
|---------|-----------|
| "Check the log for errors every morning at 9 AM" | Daily 09:00 auto log check |
| "Send a weekly report every Monday morning" | Weekly Monday report |
| "Remind me about the meeting in 5 minutes" | One-time reminder in 5 min |
| "Back up the database in half an hour" | One-time backup in 30 min |
| "Check server status every 2 hours" | Recurring check every 2h |
| "Remind me to call at 3 PM tomorrow" | One-time reminder at specific time |

### Trigger Types

| Type | Description | Use Case |
|------|-------------|----------|
| **Cron (periodic)** | Runs on a fixed schedule | "Every day at 9 AM", "Every Monday" |
| **Interval** | Runs at fixed time intervals | "Every 2 hours", "Every 30 minutes" |
| **Once** | Runs only once | "In 5 minutes", "Tomorrow at 3 PM" |

### Managing Scheduled Tasks

- Click **Scheduled Tasks** (⏰ icon) in the sidebar to see all tasks
- Each task shows: name, status, next run time, run count
- Available actions: **Pause** / **Resume** / **Run Now** / **Delete**
- Click on a task to view its **Execution History**

### Practical Examples

**Example 1: Daily News Briefing**

> You: "Every morning at 8 AM, search for today's tech news and compile a briefing"

The AI creates a daily 08:00 task that automatically searches and summarizes news.

**Example 2: Periodic Monitoring**

> You: "Check D:\logs\app.log for ERROR entries every 30 minutes"

The AI creates a recurring task that automatically reads and checks the log.

**Example 3: Delayed Reminder**

> You: "Remind me to email the client in 1 hour"

The AI creates a one-time task that fires in 60 minutes.

---

## 6. Workflows

Workflows are **standardized processes** the AI follows automatically. When your request matches a workflow, the AI executes the predefined steps.

### Built-in Workflows

OpenFlux comes with 9 preset workflows:

#### 📁 Project Initialization

**Trigger**: Say "create a new project" / "initialize project" / "scaffold"

Automatically creates a complete project structure: README, source directories, config files (package.json, tsconfig.json), .gitignore, etc.

**Example:**
> "Create a Node project called my-app in D:\projects"

#### 🐛 Systematic Bug Fix

**Trigger**: Say "fix this bug" / "troubleshoot" / "debug"

Follows a "Locate → Analyze → Fix → Verify" four-step process.

**Example:**
> "There's an error in D:\project\src\app.ts, help me debug it"

#### 🔍 Code Review

**Trigger**: Say "review this code" / "inspect code quality"

Reads code, checks structure, analyzes dependencies, summarizes issues.

**Example:**
> "Review the code quality of D:\project\src\utils.ts"

#### 🚀 Pre-Deployment Check

**Trigger**: Say "deploy check" / "pre-release check" / "ready to ship?"

Runs a standard pre-release checklist: dependency check → build test → config validation.

**Example:**
> "D:\my-project is about to go live — run a pre-deployment check"

#### 📂 Batch File Processing

**Trigger**: Say "batch process files" / "batch rename"

Scans directory, matches files, performs batch operations.

**Example:**
> "Batch rename all JPG files in D:\photos"

#### 📝 Daily Report Generation

**Trigger**: Say "write my daily report" / "today's summary"

Scans work directory, extracts key info, generates a Word daily report.

**Example:**
> "Generate a daily report based on today's changes in D:\work"

#### 📊 Data Extraction & Merge

**Trigger**: Say "merge these Excel files" / "consolidate data"

Extracts data from multiple Excel/CSV files and merges into one.

**Example:**
> "Merge all Excel files in D:\data into a single summary sheet"

#### 🗂️ File Organization

**Trigger**: Say "organize this folder" / "sort files by type"

Auto-categorizes files into subdirectories (Documents / Images / Videos / ...).

**Example:**
> "Organize the files in D:\downloads by type"

#### 📚 Learn Skill

See the next chapter: [Learning Skills](#7-learning-skills).

---

## 7. Learning Skills

Skills are a standout feature of OpenFlux: you can teach the AI **permanent new abilities** that it can use anytime.

### What is a Skill?

A Skill is like teaching the AI a professional methodology. Once learned, the AI automatically uses that methodology for related tasks instead of improvising.

### How to Teach the AI a Skill

Just say it:

| You say | What happens |
|---------|-------------|
| "Learn deep research skills" | Searches online and installs a "deep research" skill |
| "Learn how to make PPTs" | Installs PPT creation methodology |
| "Install data analysis skill" | Installs professional data analysis methods |
| "Learn academic paper writing" | Learns the standard academic writing process |

### The Learning Process

1. **Online Search**: AI searches GitHub skill libraries (OpenClaw/ClawHub) for existing skills
2. **Download & Install**: If a match is found, it's automatically downloaded and installed locally
3. **Self-Create**: If nothing exists online, the AI **creates the skill itself** based on its knowledge
4. **Persistent Storage**: Skills are saved locally and survive restarts

### Using Learned Skills

Learned skills become workflows. Just describe your task in natural language, and the AI automatically applies the relevant skill:

> Before learning: "Research quantum computing" → AI gives a generic answer
>
> After learning "Deep Research": "Do a deep research on quantum computing" → AI follows a professional research workflow: define scope → literature search → organize info → analyze perspectives → generate report

### Viewing Learned Skills

Ask the AI: "List all workflows" or "What skills have I learned?" to see all installed skills.

### Practical Examples

**Example 1: Learning "Deep Research"**

> You: "Learn deep research skills"
>
> AI: ✅ Learned "Deep Research"! I can now conduct professional deep research on any topic following a structured process: research framework → data collection → multi-perspective analysis → report writing.
>
> Later: "Do a deep research on renewable energy market trends"

**Example 2: Learning "PPT Creation"**

> You: "Learn how to make PPTs"
>
> AI: ✅ Learned "PPT Creation"! I can help you create professional presentations.
>
> Later: "Make a PPT about our annual sales summary"

**Example 3: Self-Created Skill**

> You: "Learn how to write social media content"
>
> AI: (No existing skill found online — auto-creating) ✅ Learned "Social Media Content Writing"! I'll follow a process of: topic selection → headline writing → body creation → hashtag optimization.

### Managing Skills in Settings

In **Settings → Agent → Skills**, you can:

- **Add skills manually**: Click "Add Skill", enter a title and content (Markdown format)
- **Edit existing skills**: Modify skill instructions
- **Enable/Disable skills**: Temporarily turn off a skill
- **Delete skills**: Remove when no longer needed

Skill content supports Markdown format. You can describe:
- Step-by-step procedures
- Professional knowledge and rules
- Output format requirements
- Important notes and caveats

---

## 8. Long-Term Memory

OpenFlux has long-term memory — it remembers important information from your conversations.

### How Memory Works

- The AI automatically saves **valuable information** from chats as "memory cards"
- When you ask questions later, it searches for relevant memories and uses historical context
- Example: you told it your work preferences last week, and it still remembers this week

### Memory Management

In **Settings → Memory Management** you can:

- **Browse all memories**: View saved memory cards
- **Search memories**: Enter keywords (supports semantic search — no exact match needed)
- **Filter by type**: Micro cards (small facts) / Mini cards (single knowledge) / Macro cards (summaries) / Topics
- **Delete individual memories**: Click the delete button on a card
- **Clear all memories**: One-click erase (irreversible!)
- **System info**: Total memory count, database size, vector dimensions

### Memory Distillation

The system automatically performs "memory distillation" late at night (default 02:00-06:00):

- Cleans low-quality, redundant memories
- Merges highly similar duplicate memories
- Retains valuable core information

You can also click **⚡ Manual Distill** to run immediately.

---

## 9. Voice Interaction

### Voice Input

Click the **microphone button** (🎤) next to the input box, speak into your mic, and the AI automatically converts your speech to text and sends it.

### Voice Chat Mode

Click the **Voice Chat** button to enter immersive voice mode:

- Click the center button to start talking
- AI recognizes your speech, responds, and reads the reply aloud
- You can interrupt the AI's reading by speaking
- Click exit to return to text mode

### Auto Read-Aloud

Enable "Auto read-aloud replies" in **Settings → Client → Voice** to have every AI reply automatically spoken.

### Voice Selection

Choose different voice roles in Settings to change the reading voice.

---

## 10. Browser Automation

OpenFlux can control a real browser to complete various web tasks for you.

### Capabilities

| Scenario | Example |
|----------|---------|
| Information search | "Search Google for today's trending news" |
| Price comparison | "Compare Switch console prices on Amazon vs Walmart" |
| Form filling | "Open this URL and fill out the registration form" |
| Data scraping | "Scrape all product prices from this page" |
| Automated operations | "Log into GitHub and check the latest Issues" |

### How to Use

Simply tell the AI what you want done on the web. By default, the browser window is visible so you can watch the operations in real time.

### Web Search

Beyond browser automation, the AI can directly search the internet:

> "Search for the latest developments in quantum computing"

The AI uses Brave Search to find and compile information for you.

---

## 11. File Preview & Artifacts

### File Preview

Files generated or mentioned by the AI can be previewed directly in the app:

- **Documents**: Word (.docx), Excel (.xlsx), PDF
- **Code**: All programming languages (syntax highlighted)
- **Images**: Click to view full size
- **Others**: Click "Open with default app"

Each preview window provides:
- **Open with default app**: Launch with your system's default program
- **Show in folder**: Locate the file in File Explorer
- **Copy content** / **Save as**

### Artifacts Panel

Click the 📎 button in the title bar to open the Artifacts panel. Browse all AI-generated files:

- **All**: Every generated file
- **Documents**: Word, PDF, etc.
- **Code**: Scripts and source files
- **Images**: Generated images
- **Data**: Excel, CSV data files
- **Media**: Audio, video files

---

## 12. Settings Panel

Click the ⚙️ button at the bottom of the sidebar. The settings panel has 5 tabs:

### Client Settings

- **Output Directory**: Default save location for AI-generated files
- **Debug Mode**: Shows real-time logs at the bottom (for troubleshooting)
- **Voice Settings**: Auto read-aloud, voice role selection
- **Interface Language**: Chinese / English toggle

### Server Settings

- **Model Configuration**: Choose orchestration, execution, and embedding models
- **Provider Keys**: Manage API Keys for each provider
- **Web Search**: Configure search engine API Key
- **MCP External Tools**: Add/manage extension tools (e.g., Excel, PPT)
- **Sandbox Isolation**: Security mode for code execution

### Memory Management

See [Long-Term Memory](#8-long-term-memory) chapter.

### Agent Settings

- **Name & Persona**: Global persona configuration
- **Independent Model Config**: Assign different models to each Agent
- **Skill Management**: Add, edit, enable/disable skills

### Cloud Settings

- **OpenFlux Cloud Account**: Log in/out of NexusAI cloud
- **Router Configuration**: Configure Router connection parameters
- **Managed Config**: Use Router-managed models and API Keys

---

## 13. Cloud & Remote Control

### Standalone Use (Default)

OpenFlux runs completely standalone by default. Just configure an LLM API Key and all features work.

### Connecting to Router

After connecting to OpenFlux Router, you can interact with your AI via **Feishu/Lark, WeChat**, etc.:

1. Go to **Settings → Cloud → Router** and enter the Router URL
2. Enable the connection
3. Enter the pairing code

Once connected, messages sent via Feishu chats get forwarded to your desktop OpenFlux for processing.

### Managed Mode

If your team admin has configured shared models on the Router, you can use them directly without configuring your own API Key:

Enable "Use managed config" in **Settings → Cloud → Managed Config**.

---

## 14. Tips & Best Practices

### 💡 Conversation Tips

1. **Be specific for better results**
   - ❌ "Write me a script"
   - ✅ "Write a Python script that reads D:\data\sales.csv, calculates monthly revenue, and creates a line chart"

2. **Break down complex tasks**
   - Instead of one massive request, work step by step
   - "First organize the requirements → then write the code → then test"

3. **Use @ to pick the right agent**
   - `@coder` for coding tasks
   - `@automation` for browser and scheduling tasks

4. **Drag and drop files**
   - Drop files directly into the chat for the AI to analyze
   - Supports images, documents, code files, etc.

### 💡 Scheduled Task Tips

1. **Just use natural language**
   - No need to remember any formats or commands
   - "Every Friday at 5 PM" is better than "cron 0 17 * * 5"

2. **Great use cases for scheduled tasks**
   - ⏰ Reminders: meetings, phone calls, medication
   - 📊 Regular reports: daily log checks, weekly data summaries
   - 🔍 Monitoring: server status, file changes
   - 📧 Regular sends: daily briefings, weekly newsletters

### 💡 Skill Learning Tips

1. **Learn skills first, then do tasks**
   - Learned skills produce higher quality results than ad-hoc answers
   - Best for **repeatedly used** professional methodologies

2. **Recommended skill directions**
   - Deep Research: great for information gathering and analysis
   - Code Review: great for team code quality
   - PPT Creation: great for frequent presenters
   - Data Analysis: great for spreadsheet-heavy work
   - Content Writing: great for content creators

3. **Custom skills are even more flexible**
   - Manually add skills in Settings with your own professional knowledge
   - E.g., your company's coding standards, document templates, review processes

### 💡 Workflow Tips

1. **Keyword matching**
   - Say "initialize project" → enters project creation workflow
   - Say "code review" → enters review workflow
   - No need to remember workflow names — just say related words

2. **Auto-detection**
   - The AI judges whether to use a workflow based on your description
   - "Create a Node project in D:\new" → auto-triggers project initialization

### 💡 Memory Tips

1. **Proactively tell the AI your preferences**
   - "I prefer concise answers" → AI remembers
   - "My project uses Python 3.11" → AI defaults to Python 3.11 going forward

2. **Verify with memory search**
   - Search keywords in Memory Management to confirm the AI stored information correctly

### 💡 Browser Automation Tips

1. **Describe complex operations step by step**
   - "Open Amazon → search for mechanical keyboards → sort by price → compile the top 5 into a table"

2. **Ideal automation scenarios**
   - Repetitive web operations
   - Data scraping and comparison
   - Batch form filling

---

## 15. FAQ

### The AI is stuck on "Thinking..." after I send a message?

- Check your internet connection
- Verify your API Key is valid (Settings → Server → Provider Keys)
- Free tier quota may be exhausted
- Try switching to another model provider

### Voice features are unavailable?

- Speech recognition requires downloading a voice model — initial setup takes time
- Make sure microphone permissions are granted
- Text-to-speech (read aloud) only requires internet

### Can't see the browser window during automation?

- Check if headless mode is turned off in settings
- Headless off = visible browser window

### The AI doesn't remember our previous conversation?

- Within the same session, the AI has full context
- Cross-session memory relies on "Long-Term Memory" — must be enabled in config
- Check Memory Management to verify if information was saved

### My scheduled task didn't run?

- Make sure the app is running (minimized to tray is fine)
- Check the task panel — is the status "Active"?
- View execution history for any errors

### How to switch languages?

In **Settings → Client → Interface Language**, select Chinese or English. Takes effect immediately.

### Where is my data stored? Is it safe?

- All data is stored **locally on your computer**
- Chat history is in the project's `sessions/` directory
- Long-term memory is in the `openflux_memory.db` file
- Nothing is uploaded to any third-party server
- Only LLM API calls send messages to your chosen model provider
