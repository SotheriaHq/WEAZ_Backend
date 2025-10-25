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
