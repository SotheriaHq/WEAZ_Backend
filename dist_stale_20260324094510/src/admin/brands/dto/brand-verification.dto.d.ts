export declare class SubmitVerificationDto {
    verificationPhoto1Key: string;
    verificationPhoto2Key: string;
    verificationNinKey: string;
    verificationCacKey?: string;
    verificationAddress: string;
    verificationClientEstimate: string;
}
export declare class ReviewVerificationDto {
    decision: 'APPROVED' | 'REJECTED';
    rejectionReason?: string;
}
