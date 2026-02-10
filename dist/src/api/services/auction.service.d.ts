declare class AuctionService {
    createAuction(data: any, creatorId: number): Promise<any>;
    private formatAuction;
    getAuctions(query: any): Promise<{
        auctions: any[];
        pagination: {
            total: number;
            page: number;
            limit: number;
            totalPages: number;
        };
    }>;
    getAuctionById(id: number): Promise<any>;
    placeBid(auctionId: number, bidderId: number, amount: number): Promise<{
        bid: {
            id: number;
            createdAt: Date;
            amount: import("@prisma/client-runtime-utils").Decimal;
            bidderId: number;
            auctionItemId: number;
        };
        updatedAuction: any;
    }>;
}
declare const _default: AuctionService;
export default _default;
//# sourceMappingURL=auction.service.d.ts.map