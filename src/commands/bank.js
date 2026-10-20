/**
 * Bank commands — the account's saved bank accounts, and the banks Zalo supports.
 *
 * `msg send-bank` and `msg send-qr-transfer` send a card or a QR to a thread;
 * these manage the accounts saved in Zalo's own "bank" list and read its bank
 * directory.
 */

import { getApi } from "../core/zalo-client.js";
import { success, error, info, output } from "../utils/output.js";
import { parseIntOption, parseIntAtLeast } from "../utils/parse-options.js";
import { resolveBankBin, BIN_TO_DISPLAY } from "../utils/bank-helpers.js";
import { findBankAccount, filterBanks } from "../core/bank-accounts.js";

/**
 * A bank name or BIN as the BIN Zalo wants.
 *
 * @param {string} input
 * @returns {number}
 * @throws {Error} for an unknown bank
 */
function binOrThrow(input) {
    const bin = resolveBankBin(String(input));
    if (!bin) throw new Error(`Unknown bank: '${input}'. "bank list" shows the banks Zalo supports.`);
    return bin;
}

/** One saved account as a line of text. */
function accountLine(a) {
    const bank = BIN_TO_DISPLAY[a.bin] || a.bin;
    return `  ${a.account_id}  ${bank}  ${a.bank_number}  ${a.holder_name}${a.default ? "  (default)" : ""}`;
}

export function registerBankCommands(program) {
    const bank = program.command("bank").description("Manage your saved bank accounts and list supported banks");

    bank.command("list")
        .description("List the banks Zalo supports (name, short name and BIN)")
        .option("-q, --query <text>", "Only banks whose name, short name or BIN contains this text")
        .action(async (opts) => {
            try {
                const result = await getApi().getListBank();
                const banks = filterBanks(result?.banks, opts.query);
                output({ ...result, banks }, program.opts().json, () => {
                    info(`${banks.length} bank(s)`);
                    for (const b of banks) console.log(`  ${b.bin}  ${b.short_name || "?"}  ${b.name}`);
                });
            } catch (e) {
                error(`Get banks failed: ${e.message}`);
            }
        });

    bank.command("accounts")
        .description("List your saved bank accounts")
        .option("-p, --page <n>", "Page number (starts at 0)", parseIntAtLeast(0), 0)
        .option("-l, --limit <n>", "Accounts per page", parseIntAtLeast(1), 20)
        .action(async (opts) => {
            try {
                const result = await getApi().getListBankAccount(opts.page, opts.limit);
                output(result, program.opts().json, () => {
                    const accounts = result?.myBanks ?? [];
                    info(`${accounts.length} account(s) on this page (total: ${result?.total ?? accounts.length})`);
                    for (const a of accounts) console.log(accountLine(a));
                    if (result?.hasMore) info("More accounts exist: use --page to see them.");
                });
            } catch (e) {
                error(`Get bank accounts failed: ${e.message}`);
            }
        });

    bank.command("add <accountNumber>")
        .description("Save a bank account to your Zalo bank list")
        .requiredOption("-b, --bank <name>", "Bank name (ocb, vcb, bidv, ...) or BIN code")
        .requiredOption("-n, --name <holder>", "Account holder name")
        .action(async (accountNumber, opts) => {
            try {
                const bin = binOrThrow(opts.bank);
                const result = await getApi().createBankAccount({
                    binBank: bin,
                    numAccBank: accountNumber,
                    nameAccBank: opts.name,
                });
                output(result, program.opts().json, () =>
                    success(`Bank account saved: ${BIN_TO_DISPLAY[bin] || bin} / ${accountNumber}`),
                );
            } catch (e) {
                error(`Add bank account failed: ${e.message}`);
            }
        });

    bank.command("update <accountId> <accountNumber>")
        .description('Change a saved bank account (get <accountId> from "bank accounts")')
        .requiredOption("-b, --bank <name>", "Bank name or BIN code")
        .requiredOption("-n, --name <holder>", "Account holder name")
        .action(async (accountId, accountNumber, opts) => {
            try {
                const result = await getApi().updateBankAccount({
                    accountId: parseIntOption(accountId),
                    binBank: binOrThrow(opts.bank),
                    numAccBank: accountNumber,
                    nameAccBank: opts.name,
                });
                output(result, program.opts().json, () => success("Bank account updated"));
            } catch (e) {
                error(`Update bank account failed: ${e.message}`);
            }
        });

    bank.command("remove <accountId>")
        .description('Delete a saved bank account (get <accountId> from "bank accounts")')
        .action(async (accountId) => {
            try {
                const id = parseIntOption(accountId);
                // Zalo wants to know whether the account is the default one, and only the list knows.
                const found = await findBankAccount(getApi(), id);
                if (!found) {
                    error(`No saved bank account with id ${id}. "bank accounts" lists them.`);
                    return;
                }
                const result = await getApi().deleteBankAccount({ accountId: id, isDefault: Boolean(found.default) });
                output(result, program.opts().json, () => success(`Bank account ${id} deleted`));
            } catch (e) {
                error(`Delete bank account failed: ${e.message}`);
            }
        });
}
