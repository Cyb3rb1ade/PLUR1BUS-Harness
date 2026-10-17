# Deploy checklist

1. Freeze the branch.

   Tell the channel before you do.
2. Run the migration:

   ```
   make migrate ENV=staging
   ```
3. Read the notes.

   > If the dashboard is red, stop.
