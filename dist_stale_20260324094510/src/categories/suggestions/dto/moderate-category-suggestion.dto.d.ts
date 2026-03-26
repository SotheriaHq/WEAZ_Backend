export declare enum ModerationDecision {
    APPROVE = "APPROVE",
    REJECT = "REJECT"
}
export declare class ModerateCategorySuggestionDto {
    decision: ModerationDecision;
    rejectionReason?: string;
}
