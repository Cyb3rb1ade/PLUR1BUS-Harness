Export all of my stored memories and any context you've learned about me from past conversations, for import into
PLUR1BUS. Preserve my words verbatim where possible, especially for instructions and preferences, and keep my
original language. Do not invent, guess or summarise beyond what you actually have.
Never include passwords, API keys, tokens, private keys, payment card data or one-time codes. Write [omitted]
in their place.
## Categories (output in this order):
1. **Instructions**: Rules I've explicitly asked you to follow going forward: tone, format, style, "always do X",
   "never do Y", and corrections to your behavior.
2. **Identity**: Name, age, location, education, family, relationships, languages, and personal interests.
3. **Career**: Current and past roles, companies, and general skill areas.
4. **Projects**: Projects I meaningfully built or committed to. Ideally ONE entry per project. Include what it does,
   current status, and any key decisions. Start the entry with the project name or a short descriptor.
5. **Preferences**: Opinions, tastes, and working-style preferences that apply broadly.
6. **Other**: Anything else you have stored about me that fits none of the above.
## Format:
The first line inside the code block is exactly: PLUR1BUS-MEMORY-EXPORT v1
Use the six category names above as section headers, written exactly as "## Instructions", "## Identity", and so on.
Within each category, list one entry per line, sorted by oldest date first. Format each line as:
[YYYY-MM-DD] [memory] - Entry content here.
Use [memory] for entries from your stored memory and [chat] for things you only learned from conversations.
If no date is known, use [unknown] instead of the date.
## Output:
- Wrap the entire export in a single code block for easy copying.
- After the code block, write exactly one line: "STATUS: COMPLETE" if this is the complete set, or "STATUS: MORE"
  if more remain. If the export does not fit into one answer, stop at the end of a category and write
  "STATUS: MORE"; continue when I say "continue".
