#![allow(dead_code)] // Staged policy API; domain integrations arrive in Tasks 2-4.

use crate::model::{EconomyPreset, GameSnapshot};
use crate::rejection::{GameplayRejection, GameplayResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CostPolicy {
    Standard,
    Creative,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CostQuote {
    nominal_cost: i32,
    available_budget: i32,
    affordable: bool,
    deduction: i32,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AuthorizedCost {
    nominal_cost: i32,
    deduction: i32,
}

#[derive(Debug, PartialEq)]
pub(crate) struct CostedMutation {
    snapshot: GameSnapshot,
}

impl CostPolicy {
    pub(crate) fn from_snapshot(snapshot: &GameSnapshot) -> Self {
        match snapshot.rules.economy_preset {
            EconomyPreset::Standard => Self::Standard,
            EconomyPreset::Creative => Self::Creative,
        }
    }

    pub(crate) fn quote(self, nominal_cost: i32, available_budget: i32) -> CostQuote {
        debug_assert!(nominal_cost >= 0);
        let affordable = matches!(self, Self::Creative) || available_budget >= nominal_cost;
        CostQuote {
            nominal_cost,
            available_budget,
            affordable,
            deduction: if matches!(self, Self::Standard) {
                nominal_cost
            } else {
                0
            },
        }
    }
}

impl CostQuote {
    pub(crate) fn nominal_cost(&self) -> i32 {
        self.nominal_cost
    }

    pub(crate) fn available_budget(&self) -> i32 {
        self.available_budget
    }

    pub(crate) fn affordable(&self) -> bool {
        self.affordable
    }

    pub(crate) fn authorize(self) -> GameplayResult<AuthorizedCost> {
        if !self.affordable {
            return Err(GameplayRejection::budget(
                self.nominal_cost,
                self.available_budget,
            ));
        }
        Ok(AuthorizedCost {
            nominal_cost: self.nominal_cost,
            deduction: self.deduction,
        })
    }
}

impl AuthorizedCost {
    pub(crate) fn apply_to(self, budget: &mut i32) -> GameplayResult<i32> {
        let available_budget = *budget;
        if available_budget < self.deduction {
            return Err(GameplayRejection::budget(self.deduction, available_budget));
        }
        let remaining_budget = available_budget
            .checked_sub(self.deduction)
            .ok_or_else(|| GameplayRejection::budget(self.deduction, available_budget))?;
        *budget = remaining_budget;
        Ok(self.nominal_cost)
    }
}

impl CostedMutation {
    pub(crate) fn new(snapshot: GameSnapshot) -> Self {
        Self { snapshot }
    }

    pub(crate) fn free(snapshot: GameSnapshot) -> Self {
        Self::new(snapshot)
    }

    pub(crate) fn into_snapshot(self) -> GameSnapshot {
        self.snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rejection::RejectionCode;

    #[test]
    fn standard_affordable_quote_deducts_the_full_nominal_cost_once() {
        let quote = CostPolicy::Standard.quote(500, 700);
        assert!(quote.affordable());
        assert_eq!(quote.nominal_cost(), 500);
        assert_eq!(quote.available_budget(), 700);

        let mut budget = 700;
        let reported = quote.authorize().unwrap().apply_to(&mut budget).unwrap();
        assert_eq!(reported, 500);
        assert_eq!(budget, 200);
    }

    #[test]
    fn standard_unaffordable_quote_returns_the_existing_budget_rejection() {
        let rejection = CostPolicy::Standard
            .quote(500, 499)
            .authorize()
            .unwrap_err();

        assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
        assert_eq!(rejection.context.required_budget, Some(500));
        assert_eq!(rejection.context.available_budget, Some(499));
    }

    #[test]
    fn creative_quote_is_affordable_reports_price_and_deducts_zero() {
        let quote = CostPolicy::Creative.quote(500, 0);
        assert!(quote.affordable());
        assert_eq!(quote.nominal_cost(), 500);

        let mut budget = 0;
        let reported = quote.authorize().unwrap().apply_to(&mut budget).unwrap();
        assert_eq!(reported, 500);
        assert_eq!(budget, 0);
    }

    #[test]
    fn zero_cost_is_affordable_and_budget_neutral_in_both_presets() {
        for policy in [CostPolicy::Standard, CostPolicy::Creative] {
            let mut budget = 0;
            let reported = policy
                .quote(0, budget)
                .authorize()
                .unwrap()
                .apply_to(&mut budget)
                .unwrap();
            assert_eq!(reported, 0);
            assert_eq!(budget, 0);
        }
    }

    #[test]
    fn authorization_rechecks_the_current_budget_before_deducting() {
        let authorized = CostPolicy::Standard.quote(500, 700).authorize().unwrap();
        let mut budget = 499;

        let rejection = authorized.apply_to(&mut budget).unwrap_err();

        assert_eq!(rejection.code, RejectionCode::InsufficientBudget);
        assert_eq!(rejection.context.required_budget, Some(500));
        assert_eq!(rejection.context.available_budget, Some(499));
        assert_eq!(budget, 499);
    }
}
