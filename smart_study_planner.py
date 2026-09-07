"""Smart Study Planner

A small console application for recording and reviewing study sessions.
Sessions are kept in memory while the programme is running and are saved as
JSON in ``study log.txt`` when the user exits.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional


FILE_NAME = "study log.txt"
Session = Dict[str, Any]

# The main programme uses this list.  The optional list arguments on the
# functions also make the functions easy to reuse and test independently.
sessions: List[Session] = []


def _session_list(session_list: Optional[List[Session]]) -> List[Session]:
    """Return the supplied session list, or the programme's shared list."""

    return sessions if session_list is None else session_list


def _duration_value(duration: Any) -> float:
    """Convert a duration to a finite number and reject unusable values."""

    try:
        value = float(duration)
    except (TypeError, ValueError) as error:
        raise ValueError("Duration must be a number") from error

    if not math.isfinite(value) or value <= 0:
        raise ValueError("Duration must be a positive number")
    return value


def _format_number(value: Any, decimal_places: int = 2) -> str:
    """Format numbers neatly, without showing an unnecessary .0."""

    number = float(value)
    if number.is_integer():
        return str(int(number))
    return f"{number:.{decimal_places}f}".rstrip("0").rstrip(".")


def _date_or_day(session: Session) -> str:
    """Read the date field, while accepting ``day`` from older saved data."""

    return str(session.get("date", session.get("day", "")))


def classify_session(duration: Any) -> str:
    """Classify a study session by its length.

    Sessions below 30 minutes are Short, sessions from 30 through 90 minutes
    are Medium, and sessions above 90 minutes are Long.
    """

    minutes = _duration_value(duration)
    if minutes < 30:
        return "Short"
    elif minutes <= 90:
        return "Medium"
    else:
        return "Long"


def add_session(session_list: Optional[List[Session]] = None) -> Session:
    """Prompt for a session and append it to the selected list."""

    target = _session_list(session_list)

    subject = input("Subject name: ").strip()
    topic = input("Topic covered: ").strip()
    date = input("Date or day label: ").strip()

    while True:
        duration_text = input("Duration in minutes (positive number): ").strip()
        try:
            duration = _duration_value(duration_text)
        except ValueError:
            print("Please enter a positive number for the duration.")
        else:
            break

    # Store whole minutes as ints when possible, but keep decimal minutes too.
    stored_duration: Any = int(duration) if duration.is_integer() else duration
    new_session: Session = {
        "subject": subject,
        "topic": topic,
        "date": date,
        "duration": stored_duration,
    }
    target.append(new_session)
    print("Study session added successfully.")
    return new_session


def _session_row(session: Session) -> List[str]:
    """Build one display row and call classify_session for that row."""

    duration = _duration_value(session.get("duration"))
    return [
        str(session.get("subject", "")),
        str(session.get("topic", "")),
        _date_or_day(session),
        _format_number(duration),
        classify_session(duration),
    ]


def _print_table(rows: List[List[str]]) -> None:
    """Print rows with column widths calculated from their contents."""

    headers = ["Subject", "Topic", "Date/Day", "Duration (min)", "Classification"]
    all_rows = [headers] + rows
    widths = [max(len(row[column]) for row in all_rows) for column in range(len(headers))]

    separator = "-+-".join("-" * width for width in widths)
    print(" | ".join(headers[column].ljust(widths[column]) for column in range(len(headers))))
    print(separator)
    for row in rows:
        print(" | ".join(row[column].ljust(widths[column]) for column in range(len(headers))))


def view_sessions(session_list: Optional[List[Session]] = None) -> None:
    """Display every saved session in a formatted table."""

    target = _session_list(session_list)
    if not target:
        print("No study sessions have been recorded yet.")
        return

    print("\nAll study sessions")
    rows = [_session_row(session) for session in target]
    _print_table(rows)


def search_by_subject(
    subject: Optional[str] = None, session_list: Optional[List[Session]] = None
) -> List[Session]:
    """Display sessions for a subject, matching without regard to case.

    The matching sessions are returned as well as displayed, which is useful
    to callers that want to build on the search result.
    """

    target = _session_list(session_list)
    if subject is None:
        subject = input("Enter subject to search for: ").strip()
    else:
        subject = subject.strip()

    search_term = subject.casefold()
    matching_sessions = [
        session
        for session in target
        if str(session.get("subject", "")).strip().casefold() == search_term
    ]

    if not matching_sessions:
        print(f"No sessions found for subject '{subject}'.")
        return []

    print(f"\nSessions for {subject}")
    _print_table([_session_row(session) for session in matching_sessions])
    total_minutes = sum(_duration_value(session.get("duration")) for session in matching_sessions)
    print(
        f"Total time for {subject}: {_format_number(total_minutes)} minutes "
        f"({_format_number(total_minutes / 60)} hours)."
    )
    return matching_sessions


def study_statistics(session_list: Optional[List[Session]] = None) -> Optional[Dict[str, Any]]:
    """Compute and display overall, per-subject, weakest-area and longest-session statistics."""

    target = _session_list(session_list)
    if not target:
        print("No study sessions are available for statistics.")
        return None

    total_minutes = sum(_duration_value(session.get("duration")) for session in target)

    # casefold() groups entries such as "Math" and "math" as one subject,
    # while subject_names keeps a readable spelling for the output.
    subject_totals: Dict[str, float] = {}
    subject_names: Dict[str, str] = {}
    for session in target:
        name = str(session.get("subject", "")).strip() or "(Unnamed subject)"
        key = name.casefold()
        subject_totals[key] = subject_totals.get(key, 0.0) + _duration_value(
            session.get("duration")
        )
        subject_names.setdefault(key, name)

    weakest_key = min(subject_totals, key=subject_totals.get)
    longest_session = max(target, key=lambda session: _duration_value(session.get("duration")))

    print("\nStudy statistics")
    print(f"Total hours studied overall: {total_minutes / 60:.2f}")
    print("Total time per subject:")
    for key, subject_total in subject_totals.items():
        print(
            f"  - {subject_names[key]}: {subject_total / 60:.2f} hours "
            f"({_format_number(subject_total)} minutes)"
        )

    print(
        "Weakest area (least total study time): "
        f"{subject_names[weakest_key]} - {subject_totals[weakest_key] / 60:.2f} hours"
    )
    longest_duration = _duration_value(longest_session.get("duration"))
    print(
        "Longest session: "
        f"{longest_session.get('subject', '')} | "
        f"{longest_session.get('topic', '')} | "
        f"{_date_or_day(longest_session)} | "
        f"{_format_number(longest_duration)} minutes | "
        f"{classify_session(longest_duration)}"
    )

    return {
        "total_minutes": total_minutes,
        "subject_totals": {
            subject_names[key]: value for key, value in subject_totals.items()
        },
        "weakest_subject": subject_names[weakest_key],
        "longest_session": longest_session,
    }


def save_sessions(
    session_list: Optional[List[Session]] = None, filename: str = FILE_NAME
) -> bool:
    """Save all sessions as readable JSON in ``study log.txt`` by default."""

    target = _session_list(session_list)
    try:
        path = Path(filename)
        # This is mainly useful when a different path is supplied for testing.
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as file:
            json.dump(target, file, indent=2)
            file.write("\n")
    except (OSError, TypeError, ValueError) as error:
        print(f"Could not save sessions: {error}")
        return False
    return True


def load_sessions(filename: str = FILE_NAME) -> List[Session]:
    """Load sessions from disk, returning an empty list when none exist.

    Invalid records are skipped rather than preventing the rest of the planner
    from starting.  This also makes a partially edited log file non-fatal.
    """

    try:
        with Path(filename).open("r", encoding="utf-8") as file:
            saved_data = json.load(file)
    except FileNotFoundError:
        # The first run has no log file yet, which is a normal situation.
        return []
    except (OSError, json.JSONDecodeError) as error:
        print(f"Could not load saved sessions: {error}")
        return []

    if not isinstance(saved_data, list):
        print("Could not load saved sessions: the log file does not contain a list.")
        return []

    loaded_sessions: List[Session] = []
    for item in saved_data:
        if not isinstance(item, dict):
            continue
        try:
            duration = _duration_value(item.get("duration"))
        except ValueError:
            continue

        stored_duration: Any = int(duration) if duration.is_integer() else duration
        loaded_sessions.append(
            {
                "subject": str(item.get("subject", "")),
                "topic": str(item.get("topic", "")),
                "date": str(item.get("date", item.get("day", ""))),
                "duration": stored_duration,
            }
        )
    return loaded_sessions


def _print_menu() -> None:
    """Display the options available from the main loop."""

    print("\n=== Smart Study Planner ===")
    print("1. Add a study session")
    print("2. View all sessions")
    print("3. Search sessions by subject")
    print("4. View statistics")
    print("5. Save and exit")


def main() -> None:
    """Run the menu-driven Smart Study Planner."""

    global sessions
    sessions = load_sessions()

    print("Welcome to the Smart Study Planner!")
    if sessions:
        print(f"Loaded {len(sessions)} saved session(s).")

    while True:
        _print_menu()
        try:
            choice = input("Choose an option (1-5): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nSaving sessions before exiting...")
            save_sessions()
            print("Goodbye!")
            return

        if choice == "1":
            add_session()
        elif choice == "2":
            view_sessions()
        elif choice == "3":
            search_by_subject()
        elif choice == "4":
            study_statistics()
        elif choice == "5":
            if save_sessions():
                print(f"Sessions saved to '{FILE_NAME}'.")
            print("Goodbye!")
            return
        else:
            print("Invalid choice. Please select a number from 1 to 5.")


if __name__ == "__main__":
    main()
