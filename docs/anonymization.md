# Anonymization

bbdump can copy a database with its personal data replaced, so you can work on realistic data without holding the real values. It works in two places:

- **an anonymized duplicate**: a new local database, copied with the chosen columns replaced;
- **Update from…**: the rows copied into a local database can be anonymized too.

A third feature, **Anonymize for AI**, filters what AI assistants read without copying or changing anything. It is described in [MCP Server](mcp-server.md).

## Anonymized duplicate

In a database's **⋯** menu, **Duplicate**, then turn on **Anonymize personal data** and click **Choose the data…** (or **Edit** once chosen). The summary reads, for example, "6 column(s) anonymized · 2 table(s) without rows".

![Anonymize while duplicating](../captures/anonymize.webp)

### Choosing the columns

The dialog lists the tables that hold personal data; **All tables** shows the others, and the search finds a table or a column.

Columns are detected **by their name**:

| Detected as | Column names such as |
|-------------|----------------------|
| an email | `email`, `mail`, `e_mail`, `email_address` |
| a phone number | `phone`, `mobile`, `tel`, `telephone`, `fax` |
| a name | `first_name`, `last_name`, `full_name`, `surname`…, or `name` in a table like `users`, `customers`, `contacts`, `employees` |
| an address | `address`, `street`, `addr`, `postal_code`, `zip_code` |
| an IP address | `ip`, `ip_address`, `last_ip`, `remote_ip` |
| an identifier | `iban`, `card_number`, `ssn`, `passport`, `tax_id`, `national_id` |

Detected columns are chosen already, as **Partial** (**Fake IP** for `inet` columns). Each column has a menu to pick another replacement, or **Keep**:

| Replacement | Result |
|-------------|--------|
| **Partial (start starred)** | The value keeps its shape (below) |
| **Fake email** | `user_3f2a9c1b7e4d@example.com` |
| **Fake phone** | `+000` followed by 9 digits |
| **Fake name** | `Person 3F2A9C` |
| **Fake address** | `1 Example Street 3F2A` |
| **Fake IP** | `10.x.x.x` |
| **Masked (XXXX…)** | `XXXX3F2A9C1B` |
| **Emptied (NULL)** | `NULL` |

**Partial** keeps the shape of the value, so format checks and validations still pass:

- an email keeps the end of its local part and its domain: `bob1234@email.fr` → `****234@email.fr`;
- a phone number keeps its separators and its last 2 digits: `06 12 34 56 78` → `** ** ** ** 78`;
- any other text has its first third starred: `sebastien poupi` → `*****tien poupi`.

On a column under a unique constraint or unique index, the hidden part comes from a hash instead of stars, so values stay distinct (fake values use a longer hash there too).

Replacements are deterministic: the same value always gives the same result, in every table. Links between tables and `GROUP BY`s keep working. A fake value is cut to the column's length (`varchar(n)`).

What each column can become depends on its type:

- text columns (`text`, `varchar`, `char`, `citext`): every replacement;
- `inet` / `cidr`: **Fake IP**, or NULL;
- other types (numbers, dates, `json`/`jsonb`…): **Emptied (NULL)** only, when the column allows NULL;
- primary keys, columns tied to a primary key by a foreign key, and generated columns are kept ("key, kept", "kept").

### Linked columns

A column linked by a foreign key follows the one it points to: choosing `users.email` applies the same replacement to `orders.customer_email` if a foreign key ties them. The dialog shows "Follows users.email" on one side and "Also applied to …" on the other. Since replacements are deterministic, the linked values still match.

### Tables without rows

Uncheck **Rows** to create a table empty. Tables whose name contains `session`, `token`, `otp`, `password_reset`, `refresh` or `magic_link` are left empty by default: their rows are of no use in a copy.

Emptying a table also empties every table whose foreign keys point to it ("Empty too: it points to …"), so the copy stays consistent.

### How the copy is made

1. A **schema-only** `pg_dump` of the source is written to a temporary folder (deleted afterwards).
2. The local database is created and the tables are created from that schema, without indexes, constraints or triggers yet.
3. The rows are **streamed with `COPY`** from a `SELECT` that replaces the chosen columns **on the source server**, in one read-only snapshot. The real values never reach your machine.
4. Indexes, constraints and triggers are created, sequences are set to the source's values, and materialized views are refreshed from the anonymized rows.

No backup of the source is made, since it would hold the real values. If the copy fails, the unfinished local database is removed. Anything that could not be copied is listed in the warnings at the end (for example an extension missing on the local server, see [Projects and databases](projects-and-databases.md#duplicate-to-local)).

### Limits

- Detection works on **column names only**. A column called `contact` or `info` holding emails is not found: look through **All tables** and choose it by hand.
- Free-text columns (notes, comments, messages) can hold personal data anywhere in their text. Choose them by hand: **Masked**, **Partial** or **NULL**.
- JSON columns can only be emptied (NULL), and only when they allow NULL.
- Personal data in a primary key (e.g. an email used as the key) cannot be replaced.

## Anonymization in Update from…

**Update from…** (see [Projects and databases](projects-and-databases.md#update-from)) copies the rows a local database lacks from another database of its project. On its **Choices** step, **Anonymize personal data** is on whenever columns are detected (by name, as above).

Each detected column is a chip: click it to leave it out. The chosen columns are replaced with a fake value of the detected kind (fake email, phone, name, address or IP; masked for identifiers), computed on the source server like in a duplicate. The same value gives the same fake one. The kind of replacement cannot be changed there, and only detected columns are offered: for more control, make an anonymized duplicate.

Rows already in the local database are not touched.

## Anonymize for AI

**Anonymize for AI**, in a database's **⋯** menu, uses the same column picker for a different purpose: AI assistants connected through MCP read the chosen columns anonymized, while the database itself is never changed. See [MCP Server](mcp-server.md).
