# Smart Study Planner

A console-based Python programme for logging, reviewing and analysing study
sessions throughout a semester. It stores each session as a dictionary in an
in-memory list and persists the list as `study log.txt`, so sessions are still
available the next time the programme is run.

## Run the programme

Python 3.8 or later is recommended.

```bash
python3 smart_study_planner.py
```

The menu repeats until **Save and exit** is selected. On the first run there
may be no `study log.txt`; this is handled automatically. On exit the file is
written as readable JSON. The file is local runtime data and is ignored by Git
so a student's personal study history is not accidentally committed.

## Menu options

1. **Add a study session** – records a subject, topic, date/day label and a
   positive duration in minutes. Invalid durations are rejected until a valid
   number is entered.
2. **View all sessions** – prints a table with the duration classification:
   `Short` (under 30 minutes), `Medium` (30–90 minutes), or `Long` (over 90
   minutes).
3. **Search sessions by subject** – performs a case-insensitive subject match,
   prints the matching table and reports the total time for that subject.
4. **View statistics** – reports overall hours, hours per subject, the subject
   with the least total study time, and the longest individual session.
5. **Save and exit** – saves all sessions to `study log.txt` and closes the
   programme.

## Code structure

The implementation is in [`smart_study_planner.py`](smart_study_planner.py):

- `main()` controls the menu loop and loads data at start-up.
- `add_session()` validates input and creates a session dictionary.
- `classify_session()` centralises the Short/Medium/Long rules.
- `view_sessions()` and `search_by_subject()` display formatted tables.
- `study_statistics()` calculates the requested study metrics.
- `save_sessions()` and `load_sessions()` handle JSON persistence and missing
  or malformed files without crashing.

A brief report and step-by-step operation evidence are available in
[`ANSWER_SHEET.md`](ANSWER_SHEET.md).
