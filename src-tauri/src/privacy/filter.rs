use std::sync::OnceLock;

use regex::Regex;

pub fn is_sensitive_content(text: &str) -> bool {
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return false;
    }

    sensitive_regex().is_match(trimmed) || contains_credit_card_number(trimmed)
}

fn sensitive_regex() -> &'static Regex {
    static SENSITIVE_REGEX: OnceLock<Regex> = OnceLock::new();
    SENSITIVE_REGEX.get_or_init(|| {
        Regex::new(
            r"(?x)
            \b\d{3}-\d{2}-\d{4}\b
            |
            \b\d{17}[\dXx]\b
            |
            \bAKIA[0-9A-Z]{16}\b
            |
            \b[A-Z0-9]{20,}\b
            |
            \b(?i:password|passwd|pwd)\s*[:=]\s*\S+
            ",
        )
        .expect("valid sensitive content regex")
    })
}

fn contains_credit_card_number(text: &str) -> bool {
    card_candidate_regex().find_iter(text).any(|candidate| {
        let digits: String = candidate
            .as_str()
            .chars()
            .filter(char::is_ascii_digit)
            .collect();

        (13..=19).contains(&digits.len()) && passes_luhn(&digits)
    })
}

fn card_candidate_regex() -> &'static Regex {
    static CARD_CANDIDATE_REGEX: OnceLock<Regex> = OnceLock::new();
    CARD_CANDIDATE_REGEX
        .get_or_init(|| Regex::new(r"\b(?:\d[ -]?){13,19}\b").expect("valid card regex"))
}

fn passes_luhn(digits: &str) -> bool {
    let mut sum = 0;
    let mut double = false;

    for ch in digits.chars().rev() {
        let Some(mut digit) = ch.to_digit(10) else {
            return false;
        };

        if double {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }

        sum += digit;
        double = !double;
    }

    sum % 10 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_credit_card_number() {
        assert!(is_sensitive_content("4111111111111111"));
    }

    #[test]
    fn detects_us_social_security_number() {
        assert!(is_sensitive_content("123-45-6789"));
    }

    #[test]
    fn detects_chinese_identity_number() {
        assert!(is_sensitive_content("11010519491231002X"));
    }

    #[test]
    fn detects_password_assignment() {
        assert!(is_sensitive_content("password=secret123"));
    }

    #[test]
    fn detects_aws_access_key_like_token() {
        assert!(is_sensitive_content("AKIAIOSFODNN7EXAMPLE"));
    }

    #[test]
    fn detects_generic_uppercase_alphanumeric_token() {
        assert!(is_sensitive_content("ABCDEF1234567890GHIJ"));
        assert!(is_sensitive_content("ABCDEFGHIJKLMNOPQRST"));
    }

    #[test]
    fn treats_ordinary_code_as_not_sensitive() {
        assert!(!is_sensitive_content("import React from 'react'"));
    }

    #[test]
    fn treats_ordinary_text_as_not_sensitive() {
        assert!(!is_sensitive_content("just a normal clipboard sentence"));
    }
}
