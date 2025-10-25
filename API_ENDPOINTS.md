## API Endpoints

### Auth

- **POST /auth/login**
  - Description: User login
  - Request Body: `{ email: string, password: string }`
  - Response: Access/Refresh tokens

- **POST /auth/signup**
  - Description: User signup
  - Request Body: `{ email: string, password: string, name: string, ... }`
  - Response: User created

- **POST /auth/refresh**
  - Description: Refresh access token
  - Request Body: None (uses refreshToken cookie)
  - Response: New access token

- **POST /auth/logout**
  - Description: Logout user
  - Request Body: None (uses JWT cookie)
  - Response: Logout confirmation

### File Upload

- **POST /upload/file**
  - Description: Upload a file (image/video)
  - Request Body: Multipart/form-data, field `file`
  - Auth: JWT
  - Query Params: `type: FileType`
  - Response: `{ id: string, url: string, key: string }`

- **GET /upload/files**
  - Description: Get user's uploaded files with pagination
  - Auth: JWT
  - Query Params: `cursor?: string, limit?: number, type?: FileType`
  - Response: `{ items: FileUpload[], hasNextPage: boolean, endCursor: string }`

### Posts

- **POST /posts**
  - Description: Create a new post
  - Auth: JWT
  - Request Body: `{ content?: string, imageIds?: string[], videoId?: string }`
  - Response: Created post

- **GET /posts**
  - Description: Get posts feed with pagination
  - Auth: JWT
  - Query Params: `cursor?: string, limit?: number`
  - Response: `{ items: Post[], hasNextPage: boolean, endCursor: string }`

- **GET /posts/:id**
  - Description: Get single post
  - Auth: JWT
  - Response: Post details with comments

- **PATCH /posts/:id**
  - Description: Update post (owner only)
  - Auth: JWT
  - Request Body: `{ content?: string }`
  - Response: Updated post

- **DELETE /posts/:id**
  - Description: Delete post (owner only)
  - Auth: JWT
  - Response: Success message

### Comments

- **POST /posts/:postId/comments**
  - Description: Add comment to post
  - Auth: JWT
  - Request Body: `{ content: string }`
  - Response: Created comment

- **GET /posts/:postId/comments**
  - Description: Get post comments with pagination
  - Auth: JWT
  - Query Params: `cursor?: string, limit?: number`
  - Response: `{ items: Comment[], hasNextPage: boolean, endCursor: string }`

- **PATCH /comments/:id**
  - Description: Update comment (owner only)
  - Auth: JWT
  - Request Body: `{ content: string }`
  - Response: Updated comment

- **DELETE /comments/:id**
  - Description: Delete comment (owner only)
  - Auth: JWT
  - Response: Success message

### Likes

- **POST /posts/:postId/likes**
  - Description: Toggle like on post
  - Auth: JWT
  - Response: Updated like status

- **GET /posts/:postId/likes**
  - Description: Get post likes with pagination
  - Auth: JWT
  - Query Params: `cursor?: string, limit?: number`
  - Response: `{ items: Like[], hasNextPage: boolean, endCursor: string }`

### Collections – Likes & Reactions

- **POST /collections/:id/reactions/:type**
  - Description: Toggle a reaction on a collection. `:type` is `LIKE` or `DISLIKE`. Calling with the same type twice removes it.
  - Auth: JWT, throttled
  - Response: `{ likes: number, dislikes: number }`

- **GET /collections/:id/reactions**
  - Description: List users who reacted (LIKE/DISLIKE) to a collection
  - Auth: JWT
  - Query Params: `limit?: number`
  - Response: `{ users: Array<UserSummary>, totalLikes: number, totalDislikes: number }`

- **GET /collections/:id/likes/summary**
  - Description: Aggregated likes for a collection, combining collection-level and media-level likes
  - Auth: Public
  - Response: `{ collectionLikes: number, mediaLikes: number, totalLikes: number }`

### Collection Media – Likes

- **POST /collections/media/:mediaId/reaction/like**
  - Description: Toggle like on a specific media item in a collection
  - Auth: JWT, throttled
  - Response: `{ likes: number }`

- **GET /collections/media/:mediaId/is-liked**
  - Description: Check if the current user liked the media item
  - Auth: JWT
  - Response: `{ liked: boolean }`

- **GET /collections/media/:mediaId/reactions**
  - Description: List users who liked a specific media item
  - Auth: JWT
  - Query Params: `limit?: number`
  - Response: `{ users: Array<UserSummary>, totalLikes: number }`

### Comments v2 (Unified)

- Create comment (depth <= 2)
  - POST `/api/v1/posts/:postId/comments`
  - POST `/api/v1/collections/:collectionId/comments`
  - POST `/api/v1/collections/media/:mediaId/comments`
  - Body: `{ content: string (1-500), parentId?: uuid }`

- List top-level comments for target (preloads latest 2 replies)
  - GET `/api/v1/posts/:postId/comments?cursor=&limit=`
  - GET `/api/v1/collections/:collectionId/comments?cursor=&limit=`
  - GET `/api/v1/collections/media/:mediaId/comments?cursor=&limit=`
  - Returns `{ items, hasNextPage, endCursor }`

- Get replies
  - GET `/api/v1/comments/:id/replies?cursor=&limit=`

- Like / Unlike comment (toggle)
  - POST `/api/v1/comments/:id/like` (header `x-client-event-id` optional)
  - Returns `{ liked: boolean, likeCount: number }`

- Check is-liked
  - GET `/api/v1/comments/:id/is-liked`
  - Returns `{ liked: boolean }`

- Delete comment (soft)
  - DELETE `/api/v1/comments/:id`
  - Author or target owner only; replaces content with `[deleted]`.

- Comment stats
  - GET `/api/v1/comments/:id/stats` → `{ likeCount, replyCount }`

### Profile

- **POST /auth/upload**
  - Description: Upload profile image
  - Request Body: Multipart/form-data, field `file`
  - Auth: JWT
  - Response: `{ profileImage: string }`

- **GET /auth/profile**
  - Description: Get authenticated user's profile
  - Auth: JWT
  - Response: User profile

- **PATCH /auth/update-profile/:id**
  - Description: Update user profile
  - Request Body: `{ name?: string, email?: string, profileImage?: string, ... }`
  - Auth: JWT
  - Response: Updated profile
