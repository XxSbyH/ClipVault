pub enum TextAction {
    Upper,
    Lower,
    Plain,
    Camel,
    Capitalize,
    Sentence,
    RemoveNewlines,
    AppendNewline,
    AppendCurrentTime,
}

pub fn apply_text_action(
    content: &str,
    action: TextAction,
    now: impl FnOnce() -> String,
) -> String {
    match action {
        TextAction::Upper => content.to_uppercase(),
        TextAction::Lower => content.to_lowercase(),
        TextAction::Plain => content.to_string(),
        TextAction::Camel => to_camel_case(content),
        TextAction::Capitalize => capitalize_first_non_whitespace(content),
        TextAction::Sentence => capitalize_sentences(content),
        TextAction::RemoveNewlines => remove_newlines(content),
        TextAction::AppendNewline => format!("{content}\n"),
        TextAction::AppendCurrentTime => format!("{}\n{}", content, now()),
    }
}

fn to_camel_case(content: &str) -> String {
    let mut result = String::new();

    for (index, word) in content
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .enumerate()
    {
        let lower = word.to_lowercase();
        if index == 0 {
            result.push_str(&lower);
        } else {
            let mut chars = lower.chars();
            if let Some(first) = chars.next() {
                result.extend(first.to_uppercase());
                result.push_str(chars.as_str());
            }
        }
    }

    result
}

fn capitalize_first_non_whitespace(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut capitalized = false;

    for character in content.chars() {
        if !capitalized && !character.is_whitespace() {
            result.extend(character.to_uppercase());
            capitalized = true;
        } else {
            result.push(character);
        }
    }

    result
}

fn capitalize_sentences(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut should_capitalize = true;

    for character in content.chars() {
        if should_capitalize && character.is_alphabetic() {
            result.extend(character.to_uppercase());
            should_capitalize = false;
        } else {
            result.push(character);
        }

        if is_sentence_boundary(character) {
            should_capitalize = true;
        } else if should_capitalize && character.is_alphanumeric() {
            should_capitalize = false;
        }
    }

    result
}

fn is_sentence_boundary(character: char) -> bool {
    matches!(character, '.' | '!' | '?' | '。' | '！' | '？')
}

fn remove_newlines(content: &str) -> String {
    let mut result = String::with_capacity(content.len());
    let mut pending_space = false;
    let mut previous_was_carriage_return = false;

    for character in content.chars() {
        if character == '\r' || character == '\n' {
            if character == '\n' && previous_was_carriage_return {
                previous_was_carriage_return = false;
                continue;
            }

            pending_space = !result.is_empty() && !result.ends_with(char::is_whitespace);
            previous_was_carriage_return = character == '\r';
            continue;
        }

        previous_was_carriage_return = false;

        if pending_space {
            if character.is_whitespace() {
                continue;
            }
            result.push(' ');
            pending_space = false;
        }

        result.push(character);
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upper_converts_all_text_to_uppercase() {
        assert_eq!(
            apply_text_action("Hello World 123", TextAction::Upper, || unreachable!()),
            "HELLO WORLD 123"
        );
    }

    #[test]
    fn lower_converts_all_text_to_lowercase() {
        assert_eq!(
            apply_text_action("Hello World 123", TextAction::Lower, || unreachable!()),
            "hello world 123"
        );
    }

    #[test]
    fn camel_converts_words_to_lower_camel_case() {
        assert_eq!(
            apply_text_action("hello world-example", TextAction::Camel, || unreachable!()),
            "helloWorldExample"
        );
        assert_eq!(
            apply_text_action("Order ID value", TextAction::Camel, || unreachable!()),
            "orderIdValue"
        );
    }

    #[test]
    fn capitalize_uppercases_first_non_whitespace_character() {
        assert_eq!(
            apply_text_action("  hello world", TextAction::Capitalize, || unreachable!()),
            "  Hello world"
        );
    }

    #[test]
    fn sentence_capitalizes_after_sentence_boundaries() {
        assert_eq!(
            apply_text_action(
                "hello. next item! done?",
                TextAction::Sentence,
                || unreachable!()
            ),
            "Hello. Next item! Done?"
        );
    }

    #[test]
    fn sentence_recognizes_chinese_sentence_boundaries() {
        assert_eq!(
            apply_text_action(
                "你好。hello！next？done",
                TextAction::Sentence,
                || unreachable!()
            ),
            "你好。Hello！Next？Done"
        );
    }

    #[test]
    fn sentence_skips_opening_quotes_and_parentheses_after_boundaries() {
        assert_eq!(
            apply_text_action(
                "hello. \"next\" hello. (again)",
                TextAction::Sentence,
                || unreachable!()
            ),
            "Hello. \"Next\" hello. (Again)"
        );
    }

    #[test]
    fn remove_newlines_replaces_line_breaks_with_spaces() {
        assert_eq!(
            apply_text_action(
                "alpha\nbeta\r\n gamma",
                TextAction::RemoveNewlines,
                || unreachable!()
            ),
            "alpha beta gamma"
        );
    }

    #[test]
    fn append_newline_adds_one_trailing_newline() {
        assert_eq!(
            apply_text_action("alpha", TextAction::AppendNewline, || unreachable!()),
            "alpha\n"
        );
    }

    #[test]
    fn append_current_time_adds_timestamp_on_new_line() {
        assert_eq!(
            apply_text_action("alpha", TextAction::AppendCurrentTime, || {
                "2026-06-25 10:20:30".to_string()
            }),
            "alpha\n2026-06-25 10:20:30"
        );
    }
}
