<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="200" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://coveralls.io/github/nestjs/nest?branch=master" target="_blank"><img src="https://coveralls.io/repos/github/nestjs/nest/badge.svg?branch=master#9" alt="Coverage" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Installation

```bash
$ npm install
```

## Running the app

```bash
# development
$ npm run start


# watch mode

$ npm run start:dev


# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://kamilmysliwiec.com)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)


## API Endpoints

### Authentication

- **POST /auth/signup**
  - Description: Register a new user
  - Request Body:
    ```json
    {
      "email": "user@example.com",
      "password": "securePassword123",
      "username": "username",
      "firstName": "John",
      "lastName": "Doe",
      "type": "REGULAR", // or "BRAND"
      // Optional fields for BRAND type
      "brandFullName": "Company Name",
      "cacNumber": "CAC123456",
      "tin": "TIN123456",
      "ceoNin": "NIN123456",
      "ceoFirstName": "CEO First",
      "ceoLastName": "CEO Last",
      "companyLocation": "Company Address"
    }
    ```
  - Response:
    ```json
    {
      "user": {
        "id": "uuid",
        "email": "user@example.com",
        "username": "username",
        // ... other user fields
      },
      "accessToken": "jwt_token",
      "refreshToken": "refresh_token"
    }
    ```

- **POST /auth/login**
  - Description: User login
  - Request Body:
    ```json
    {
      "email": "user@example.com",
      "password": "securePassword123"
    }
    ```
  - Response: Same as signup response

### Files

- **POST /upload/file**
  - Description: Upload a file
  - Request Body: Multipart/form-data
    - `file`: File to upload
    - `type`: One of `PROFILE_IMAGE`, `POST_IMAGE`, `POST_VIDEO`, `DOCUMENT`
  - Auth: JWT
  - Response:
    ```json
    {
      "id": "uuid",
      "url": "s3_url",
      "key": "file_key",
      "originalName": "filename.jpg",
      "size": 1234567,
      "mimeType": "image/jpeg"
    }
    ```

- **GET /upload/files**
  - Description: Get user's files with pagination
  - Query Parameters:
    - `cursor`: Timestamp for pagination
    - `limit`: Number of items per page (default: 20, max: 50)
    - `type`: Optional file type filter
  - Auth: JWT
  - Response:
    ```json
    {
      "items": [{
        "id": "uuid",
        "url": "s3_url",
        "key": "file_key",
        "originalName": "filename.jpg",
        "size": 1234567,
        "mimeType": "image/jpeg",
        "createdAt": "2025-08-06T..."
      }],
      "hasNextPage": true,
      "endCursor": "2025-08-06T..."
    }
    ```

### Posts

- **POST /posts**
  - Description: Create a new post
  - Request Body:
    ```json
    {
      "content": "Post content text",
      "imageIds": ["uuid1", "uuid2"], // Optional
      "videoId": "uuid" // Optional
    }
    ```
  - Auth: JWT
  - Response:
    ```json
    {
      "id": "uuid",
      "content": "Post content text",
      "imageIds": ["uuid1", "uuid2"],
      "videoId": "uuid",
      "user": { /* user object */ },
      "images": [{ /* image objects */ }],
      "video": { /* video object */ },
      "comments": [{ /* latest 5 comments */ }],
      "_count": {
        "likes": 0,
        "comments": 0
      },
      "createdAt": "2025-08-06T..."
    }
    ```

- **GET /posts**
  - Description: Get posts feed with pagination
  - Query Parameters:
    - `cursor`: Timestamp for pagination
    - `limit`: Number of items per page (default: 20, max: 50)
  - Auth: JWT
  - Response:
    ```json
    {
      "items": [/* array of post objects */],
      "hasNextPage": true,
      "endCursor": "2025-08-06T..."
    }
    ```

- **GET /posts/:id**
  - Description: Get single post
  - Auth: JWT
  - Response: Post object with relationships

- **PATCH /posts/:id**
  - Description: Update post (owner only)
  - Request Body:
    ```json
    {
      "content": "Updated content"
    }
    ```
  - Auth: JWT
  - Response: Updated post object

- **DELETE /posts/:id**
  - Description: Delete post (owner only)
  - Auth: JWT
  - Response: `204 No Content`

### Comments

- **POST /posts/:postId/comments**
  - Description: Add comment to post
  - Request Body:
    ```json
    {
      "content": "Comment text"
    }
    ```
  - Auth: JWT
  - Response:
    ```json
    {
      "id": "uuid",
      "content": "Comment text",
      "user": {
        "id": "uuid",
        "username": "username",
        "firstName": "John",
        "lastName": "Doe",
        "profileImage": "url"
      },
      "createdAt": "2025-08-06T..."
    }
    ```

- **GET /posts/:postId/comments**
  - Description: Get post comments with pagination
  - Query Parameters:
    - `cursor`: Timestamp for pagination
    - `limit`: Number of items per page (default: 20, max: 50)
  - Auth: JWT
  - Response:
    ```json
    {
      "items": [/* array of comment objects */],
      "hasNextPage": true,
      "endCursor": "2025-08-06T..."
    }
    ```

- **PATCH /posts/:postId/comments/:id**
  - Description: Update comment (owner only)
  - Request Body:
    ```json
    {
      "content": "Updated comment"
    }
    ```
  - Auth: JWT
  - Response: Updated comment object

- **DELETE /posts/:postId/comments/:id**
  - Description: Delete comment (owner only)
  - Auth: JWT
  - Response: `204 No Content`

### Likes

- **POST /posts/:postId/likes**
  - Description: Toggle like on post
  - Auth: JWT
  - Response:
    ```json
    {
      "liked": true,
      "likesCount": 42
    }
    ```

- **GET /posts/:postId/likes**
  - Description: Get users who liked the post
  - Auth: JWT
  - Response:
    ```json
    {
      "users": [{
        "id": "uuid",
        "username": "username",
        "firstName": "John",
        "lastName": "Doe",
        "profileImage": "url"
      }],
      "total": 42
    }
    ```

- **GET /posts/:postId/is-liked**
  - Description: Check if current user liked the post
  - Auth: JWT
  - Response:
    ```json
    true
    ```

---

### Social (Follows / Sews)

- **POST /follows**
  - Description: Follow a user (sew)
  - Auth: JWT
  - Request Body:
    ```json
    { "targetId": "<user-id-to-follow>" }
    ```
  - Response:
    ```json
    {
      "id": "uuid",
      "followerId": "<your-id>",
      "followingId": "<target-id>",
      "createdAt": "2025-08-23T..."
    }
    ```

- **DELETE /follows/:targetId**
  - Description: Unfollow a user
  - Auth: JWT
  - Response: `{ "message": "Unfollowed" }`

- **GET /follows/followers/:userId**
  - Description: Get followers (sews) for a user
  - Query: `limit`, `cursor`
  - Response: paginated list of followers with basic user info

- **GET /follows/following/:userId**
  - Description: Get who the user is following
  - Query: `limit`, `cursor`
  - Response: paginated list of following users with basic user info

Note: Any user (brand or regular) can follow a brand; brands can follow brands or regular users.

### Collections & Likes

Collections persist reactions and related user ids. For each collection we store individual `CollectionReaction` rows (userId + type) so owners can list which users liked or disliked their collection (not just counts).


Nest is [MIT licensed](LICENSE).
