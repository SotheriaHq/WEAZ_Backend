declare class ServerFileDto {
    originalName: string;
    contentType: string;
    base64: string;
    fileType?: string;
}
export declare class ServerUploadDto {
    title?: string;
    description?: string;
    files: ServerFileDto[];
}
export {};
