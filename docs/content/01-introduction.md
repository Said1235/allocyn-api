---
title: Introduction
group: Start
summary: What Allocyn is, what the API and SDK do, and what they do not do.
---
# Introduction

Allocyn checks digital work against acceptance criteria agreed in advance. A **client** writes the terms (a title, a description and 1–20 criteria). A **worker** accepts them and delivers a public link. Validators on GenLayer read that link and judge each criterion; the verdict is stored on the contract as a **receipt**.

This site documents two ways to use that contract from code:

| | What it is | Use it to |
|---|---|---|
| **REST API** (`/v1`) | Read-only HTTP endpoints over the contract | Let an agent, a dashboard or any app read jobs, receipts and transactions without a wallet |
| **SDK** (`@allocyn/sdk`) | A typed TypeScript client | Do everything the API does, **and** send writes signed by a wallet you control |

<div class="diagram" data-diagram="arch"></div>

## What it does not do

Being exact about this matters more than sounding impressive.

- It is **not a payment or escrow system.** No money moves. A verdict does not release or hold funds.
- It is **not dispute resolution** and not a legal determination.
- A `VERIFIED` result means validators judged the delivered text *met the written criteria*. It is **not an objective measure of quality**, and an LLM-assisted verdict is not guaranteed to be the same on every run.
- It does **not make the validators immune to prompt injection.** The delivered page is untrusted text that an LLM reads. The contract constrains what a verdict can look like, but the SDK and API cannot promise more than the contract does.
- The API holds **no database and no wallet.** Everything it returns is read from the contract at request time.

## Where things run

| Piece | Network | Status |
|---|---|---|
| Contract | GenLayer **Studionet** (chain `61999`) | Deployed at `0x5729a3b514654Ec5966A1DCa8e5088ef7A70bBDA` |
| API and SDK | Studionet only | Mainnet-style networks are not enabled |

The contract's source calls itself *Smart Agreement* (class `SmartAgreement`); the product built on it is called Allocyn. Method names and ids (`create_job`, `job-1`, `rcpt-1`) are the contract's own.

> **Verification status of this documentation.** The API and SDK are tested here against an in-memory simulation of the contract and, for the data shapes, against fixtures generated from the contract's real Python code. They have **not** been run against the live Studionet RPC or a real wallet from the environment where they were written. See [Networks](networks.html) for how to run that check yourself.
